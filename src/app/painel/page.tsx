"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Home,
  Clock,
  AlertTriangle,
  PackageCheck,
  Layers,
  ChevronRight,
  AlertCircle,
  FileWarning,
  Timer,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PainelResponse {
  server_time: string;
  galpoes: { id: string; nome: string }[];
  pipeline: Record<string, number>;
  sla: {
    overdue: number;
    urgent: number;
    attention: number;
    on_time: number;
    no_deadline: number;
  };
  throughput: {
    buckets: { hour: number; count: number }[];
    total_today: number;
  };
  alerts: {
    overdue_count: number;
    stuck_nf: number;
    stuck_separacao: number;
    recent_errors: number;
    error_samples: { source: string; message: string; timestamp: string }[];
  };
  kpis: {
    processed_today: number;
    pipeline_total: number;
    overdue_count: number;
    avg_cycle_time_min: number | null;
  };
}

// ─── Pipeline config ────────────────────────────────────────────────────────

const PIPELINE_STAGES = [
  { key: "aguardando_compra", label: "Ag.OC", tab: "aguardando_compra" },
  { key: "aguardando_nf", label: "Ag.NF", tab: "aguardando_nf" },
  { key: "aguardando_separacao", label: "Ag.Sep", tab: "aguardando_separacao" },
  { key: "em_separacao", label: "Em Sep", tab: "em_separacao" },
  { key: "separado", label: "Separado", tab: "separado" },
  { key: "embalado", label: "Embalado", tab: "embalado" },
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCycleTime(minutes: number | null): string {
  if (minutes === null) return "--";
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min atrás`;
  const h = Math.floor(m / 60);
  return `${h}h atrás`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function PainelPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);

  const [galpaoFilter, setGalpaoFilter] = useState("");
  const [clockTime, setClockTime] = useState(new Date());
  const [serverOffset, setServerOffset] = useState(0);

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Live clock (1s)
  useEffect(() => {
    const interval = setInterval(() => setClockTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Supabase Realtime
  useEffect(() => {
    const channel = supabase
      .channel("painel_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "siso_pedidos" },
        () => queryClient.invalidateQueries({ queryKey: ["painel"] }),
      )
      .subscribe();
    channelRef.current = channel;
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [queryClient]);

  // Query params
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (galpaoFilter) params.set("galpao_id", galpaoFilter);
    return params.toString();
  }, [galpaoFilter]);

  // Fetch
  const { data } = useQuery<PainelResponse>({
    queryKey: ["painel", queryParams],
    queryFn: async () => {
      const url = queryParams ? `/api/painel?${queryParams}` : "/api/painel";
      const res = await sisoFetch(url);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !loading && !!user,
    refetchInterval: 30_000,
  });

  // Server time sync
  useEffect(() => {
    if (data?.server_time) {
      setServerOffset(new Date(data.server_time).getTime() - Date.now());
    }
  }, [data?.server_time]);

  // Clock display
  const clockDisplay = useMemo(() => {
    const synced = new Date(clockTime.getTime() + serverOffset);
    return synced.toLocaleTimeString("pt-BR", { hour12: false });
  }, [clockTime, serverOffset]);

  const galpoes = data?.galpoes ?? [];
  const pipeline = data?.pipeline ?? {};
  const sla = data?.sla ?? { overdue: 0, urgent: 0, attention: 0, on_time: 0, no_deadline: 0 };
  const throughput = data?.throughput ?? { buckets: [], total_today: 0 };
  const alerts = data?.alerts ?? { overdue_count: 0, stuck_nf: 0, stuck_separacao: 0, recent_errors: 0, error_samples: [] };
  const kpis = data?.kpis ?? { processed_today: 0, pipeline_total: 0, overdue_count: 0, avg_cycle_time_min: null };

  // Find pipeline bottleneck (stage with most items, excluding embalado)
  const bottleneckKey = useMemo(() => {
    let max = 0;
    let key = "";
    for (const stage of PIPELINE_STAGES) {
      if (stage.key === "embalado") continue;
      const count = pipeline[stage.key] ?? 0;
      if (count > max) { max = count; key = stage.key; }
    }
    return max > 0 ? key : null;
  }, [pipeline]);

  // SLA bars
  const slaGroups = useMemo(() => {
    const total = sla.overdue + sla.urgent + sla.attention + sla.on_time + sla.no_deadline;
    return [
      { key: "overdue", label: "Atrasados", count: sla.overdue, color: "bg-red-500", icon: "🔴" },
      { key: "urgent", label: "Urgentes <2h", count: sla.urgent, color: "bg-orange-500", icon: "🟠" },
      { key: "attention", label: "Atenção <4h", count: sla.attention, color: "bg-amber-500", icon: "🟡" },
      { key: "on_time", label: "No prazo", count: sla.on_time, color: "bg-emerald-500", icon: "🟢" },
      { key: "no_deadline", label: "Sem prazo", count: sla.no_deadline, color: "bg-zinc-400", icon: "⚪" },
    ].map((g) => ({ ...g, pct: total > 0 ? (g.count / total) * 100 : 0 }));
  }, [sla]);

  // Alert items
  const alertItems = useMemo(() => {
    const items: { icon: typeof AlertTriangle; color: string; bgColor: string; label: string; count: number; href: string }[] = [];
    if (alerts.overdue_count > 0)
      items.push({ icon: AlertTriangle, color: "text-red-500", bgColor: "bg-red-50 dark:bg-red-950/30", label: "pedidos atrasados", count: alerts.overdue_count, href: "/separacao" });
    if (alerts.stuck_nf > 0)
      items.push({ icon: FileWarning, color: "text-amber-500", bgColor: "bg-amber-50 dark:bg-amber-950/30", label: "aguardando NF há >4h", count: alerts.stuck_nf, href: "/separacao?tab=aguardando_nf" });
    if (alerts.stuck_separacao > 0)
      items.push({ icon: Timer, color: "text-violet-500", bgColor: "bg-violet-50 dark:bg-violet-950/30", label: "em separação há >2h", count: alerts.stuck_separacao, href: "/separacao?tab=em_separacao" });
    if (alerts.recent_errors > 0)
      items.push({ icon: XCircle, color: "text-red-500", bgColor: "bg-red-50 dark:bg-red-950/30", label: "erros na última hora", count: alerts.recent_errors, href: "/monitoramento" });
    return items;
  }, [alerts]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-surface">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          <Link
            href="/"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
            title="Inicio"
          >
            <Home className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-bold tracking-tight text-ink sm:text-base">
            Torre de Controle
          </h1>

          <div className="flex-1" />

          {/* Galpao filter pills */}
          {galpoes.length > 1 && (
            <div className="flex items-center gap-1">
              {[{ id: "", nome: "Todos" }, ...galpoes].map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGalpaoFilter(g.id)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    galpaoFilter === g.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-ink-faint hover:bg-surface hover:text-ink",
                  )}
                >
                  {g.nome}
                </button>
              ))}
            </div>
          )}

          {/* Clock */}
          <div className="shrink-0 font-mono text-sm font-bold tabular-nums text-ink">
            {clockDisplay}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4">
        {/* ── KPI Cards ──────────────────────────────────────────────────── */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label="Processados hoje"
            value={kpis.processed_today}
            icon={PackageCheck}
            color="text-emerald-500"
          />
          <KpiCard
            label="Pipeline ativo"
            value={kpis.pipeline_total}
            icon={Layers}
            color="text-blue-500"
          />
          <KpiCard
            label="Atrasados"
            value={kpis.overdue_count}
            icon={AlertTriangle}
            color="text-red-500"
            pulse={kpis.overdue_count > 0}
          />
          <KpiCard
            label="Tempo médio"
            value={formatCycleTime(kpis.avg_cycle_time_min)}
            icon={Clock}
            color="text-amber-500"
          />
        </section>

        {/* ── Pipeline Funnel ────────────────────────────────────────────── */}
        <section className="rounded-xl border border-line bg-paper p-4">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-faint">
            Pipeline
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {PIPELINE_STAGES.map((stage, i) => {
              const count = pipeline[stage.key] ?? 0;
              const isBottleneck = stage.key === bottleneckKey;
              return (
                <div key={stage.key} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint/50" />
                  )}
                  <Link
                    href={`/separacao?tab=${stage.tab}`}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      isBottleneck
                        ? "ring-2 ring-amber-400 bg-amber-50 text-amber-800 dark:ring-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
                        : "bg-zinc-50 text-ink-muted dark:bg-zinc-800/60",
                    )}
                  >
                    <span className="font-mono tabular-nums">{count}</span>
                    <span>{stage.label}</span>
                  </Link>
                </div>
              );
            })}
          </div>
          {bottleneckKey && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              Gargalo: {PIPELINE_STAGES.find((s) => s.key === bottleneckKey)?.label}
            </p>
          )}
        </section>

        {/* ── SLA + Throughput + Alerts ───────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Left column: SLA + Throughput */}
          <div className="space-y-4">
            {/* SLA Bars */}
            <section className="rounded-xl border border-line bg-paper p-4">
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-faint">
                Prazos de Envio
              </h2>
              <div className="space-y-2">
                {slaGroups.map((g) => (
                  <div key={g.key} className="flex items-center gap-2">
                    <span className="w-4 text-center text-xs">{g.icon}</span>
                    <span className="w-16 font-mono text-xs font-bold tabular-nums text-ink">
                      {g.count}
                    </span>
                    <span className="w-24 truncate text-xs text-ink-muted">
                      {g.label}
                    </span>
                    <div className="flex-1">
                      <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div
                          className={cn("h-full rounded-full transition-all", g.color)}
                          style={{ width: `${Math.max(g.pct, g.count > 0 ? 2 : 0)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Throughput Chart */}
            <section className="rounded-xl border border-line bg-paper p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-wider text-ink-faint">
                  Throughput Hoje
                </h2>
                <span className="font-mono text-xs font-bold tabular-nums text-ink">
                  {throughput.total_today} total
                </span>
              </div>
              <ThroughputChart buckets={throughput.buckets} />
            </section>
          </div>

          {/* Right column: Alerts */}
          <section className="rounded-xl border border-line bg-paper p-4">
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-faint">
              Alertas
            </h2>
            {alertItems.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-4 dark:bg-emerald-950/30">
                <PackageCheck className="h-4 w-4 text-emerald-500" />
                <p className="text-sm text-emerald-700 dark:text-emerald-400">
                  Nenhum alerta no momento
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {alertItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.label}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:brightness-95",
                        item.bgColor,
                      )}
                    >
                      <Icon className={cn("h-4 w-4 shrink-0", item.color)} />
                      <span className={cn("font-mono text-lg font-bold tabular-nums", item.color)}>
                        {item.count}
                      </span>
                      <span className="flex-1 text-sm text-ink">{item.label}</span>
                      <ChevronRight className="h-4 w-4 text-ink-faint" />
                    </Link>
                  );
                })}
              </div>
            )}

            {/* Error samples */}
            {alerts.error_samples.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Erros recentes
                </p>
                <div className="space-y-2">
                  {alerts.error_samples.map((err, i) => (
                    <div key={i} className="text-xs">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-600 dark:bg-red-950/40 dark:text-red-400">
                          {err.source}
                        </span>
                        <span className="text-[10px] text-ink-faint">
                          {formatRelative(err.timestamp)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-ink-muted">{err.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  icon: Icon,
  color,
  pulse,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
  pulse?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-line bg-paper p-4",
        pulse && "animate-pulse-urgent border-red-300 dark:border-red-800",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <Icon className={cn("h-4 w-4", color)} />
      </div>
      <p className="font-mono text-2xl font-bold tracking-tight tabular-nums text-ink">
        {value}
      </p>
    </div>
  );
}

// ─── Throughput Chart ────────────────────────────────────────────────────────

function ThroughputChart({ buckets }: { buckets: { hour: number; count: number }[] }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);

  // Current BRT hour for highlight
  const nowBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const currentHour = nowBrt.getUTCHours();

  // Show 6h..current+1 range for relevance
  const startHour = Math.max(0, 6);
  const endHour = Math.min(23, Math.max(currentHour + 1, 18));
  const visible = buckets.filter((b) => b.hour >= startHour && b.hour <= endHour);

  if (visible.length === 0) {
    return <p className="text-xs text-ink-faint">Nenhum dado disponível.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex h-20 items-end gap-0.5">
        {visible.map((bucket) => {
          const pct = (bucket.count / max) * 100;
          const isCurrent = bucket.hour === currentHour;
          return (
            <div
              key={bucket.hour}
              className="group relative flex flex-1 flex-col items-center justify-end"
            >
              <div
                className={cn(
                  "w-full rounded-t transition-all",
                  isCurrent
                    ? "bg-blue-500 dark:bg-blue-400"
                    : "bg-blue-400/60 dark:bg-blue-500/40",
                )}
                style={{ height: `${Math.max(pct, bucket.count > 0 ? 4 : 0)}%` }}
              />
              {bucket.count > 0 && (
                <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-zinc-700">
                  {bucket.count}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between">
        <span className="text-[10px] text-ink-faint">
          {visible[0]?.hour ?? 0}h
        </span>
        <span className="text-[10px] text-ink-faint">
          {visible[visible.length - 1]?.hour ?? 23}h
        </span>
      </div>
    </div>
  );
}
