"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Home,
  Clock,
  PackageCheck,
  Layers,
  ChevronRight,
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
  client_received_at?: number;
  galpoes: { id: string; nome: string }[];
  pipeline: Record<string, number>;
  throughput: {
    buckets: { hour: number; count: number }[];
    total_today: number;
  };
  alerts: {
    stuck_nf: number;
    stuck_separacao: number;
    recent_errors: number;
    error_samples: { source: string; message: string; timestamp: string }[];
  };
  kpis: {
    processed_today: number;
    pipeline_total: number;
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

const EMPTY_PIPELINE: Record<string, number> = {
  aguardando_compra: 0,
  aguardando_nf: 0,
  aguardando_separacao: 0,
  em_separacao: 0,
  separado: 0,
  embalado: 0,
};

const EMPTY_THROUGHPUT = { buckets: [], total_today: 0 } satisfies PainelResponse["throughput"];
const EMPTY_ALERTS = {
  stuck_nf: 0,
  stuck_separacao: 0,
  recent_errors: 0,
  error_samples: [],
} satisfies PainelResponse["alerts"];
const EMPTY_KPIS = {
  processed_today: 0,
  pipeline_total: 0,
  avg_cycle_time_min: null,
} satisfies PainelResponse["kpis"];

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCycleTime(minutes: number | null): string {
  if (minutes === null) return "--";
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatRelative(nowMs: number, iso: string): string {
  const diff = nowMs - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min atrás`;
  const h = Math.floor(m / 60);
  return `${h}h atrás`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function PainelPage() {
  const { user, loading, activeGalpaoId, setActiveGalpao } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);

  const [clockTime, setClockTime] = useState(new Date());

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
    if (activeGalpaoId) params.set("galpao_id", activeGalpaoId);
    return params.toString();
  }, [activeGalpaoId]);

  // Fetch
  const { data } = useQuery<PainelResponse>({
    queryKey: ["painel", queryParams],
    queryFn: async () => {
      const url = queryParams ? `/api/painel?${queryParams}` : "/api/painel";
      const clientReceivedAt = Date.now();
      const res = await sisoFetch(url);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return {
        ...json,
        client_received_at: clientReceivedAt,
      };
    },
    enabled: !loading && !!user,
    refetchInterval: 30_000,
  });

  const clockDisplay = !data?.server_time || !data.client_received_at
    ? clockTime.toLocaleTimeString("pt-BR", { hour12: false })
    : new Date(
        clockTime.getTime() +
          (new Date(data.server_time).getTime() - data.client_received_at),
      ).toLocaleTimeString("pt-BR", { hour12: false });

  const galpoes = data?.galpoes ?? [];
  const pipeline = data?.pipeline ?? EMPTY_PIPELINE;
  const throughput = data?.throughput ?? EMPTY_THROUGHPUT;
  const alerts = data?.alerts ?? EMPTY_ALERTS;
  const kpis = data?.kpis ?? EMPTY_KPIS;
  const currentBrtHour = useMemo(
    () => new Date(clockTime.getTime() - 3 * 60 * 60 * 1000).getUTCHours(),
    [clockTime],
  );

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

  // Alert items
  const alertItems = useMemo(() => {
    const items: { icon: typeof Clock; color: string; bgColor: string; label: string; count: number; href: string }[] = [];
    if (alerts.stuck_nf > 0)
      items.push({ icon: FileWarning, color: "text-amber-500", bgColor: "bg-amber-50 dark:bg-amber-950/30", label: "aguardando NF há >4h", count: alerts.stuck_nf, href: "/separacao?tab=aguardando_nf" });
    if (alerts.stuck_separacao > 0)
      items.push({ icon: Timer, color: "text-violet-500", bgColor: "bg-violet-50 dark:bg-violet-950/30", label: "em separação há >2h", count: alerts.stuck_separacao, href: "/separacao?tab=em_separacao" });
    if (alerts.recent_errors > 0)
      items.push({ icon: XCircle, color: "text-red-500", bgColor: "bg-red-50 dark:bg-red-950/30", label: "erros na última hora", count: alerts.recent_errors, href: "/monitoramento" });
    return items;
  }, [alerts]);

  const recommendedAction = useMemo(() => {
    if (alerts.stuck_nf > 0) {
      return {
        icon: FileWarning,
        href: "/separacao?tab=aguardando_nf",
        title: `${alerts.stuck_nf} pedido(s) travados em NF`,
        description: "Há pedidos aguardando nota fiscal acima do SLA. Essa é a primeira fila a destravar.",
        cta: "Abrir aguardando NF",
        panelClassName: "border-amber-200 bg-amber-50/80 dark:border-amber-800 dark:bg-amber-950/20",
        iconClassName: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
      };
    }

    if (alerts.stuck_separacao > 0) {
      return {
        icon: Timer,
        href: "/separacao?tab=em_separacao",
        title: `${alerts.stuck_separacao} pedido(s) parados em separação`,
        description: "Existem separações abertas há mais de 2 horas. Vale retomar essa execução antes de puxar novas ondas.",
        cta: "Retomar separação",
        panelClassName: "border-violet-200 bg-violet-50/80 dark:border-violet-800 dark:bg-violet-950/20",
        iconClassName: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
      };
    }

    if (alerts.recent_errors > 0) {
      return {
        icon: XCircle,
        href: "/monitoramento",
        title: `${alerts.recent_errors} erro(s) recente(s) no fluxo`,
        description: "Os erros da última hora merecem revisão para evitar que o gargalo aumente por falha silenciosa.",
        cta: "Abrir monitoramento",
        panelClassName: "border-red-200 bg-red-50/80 dark:border-red-800 dark:bg-red-950/20",
        iconClassName: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
      };
    }

    if (bottleneckKey) {
      const stage = PIPELINE_STAGES.find((item) => item.key === bottleneckKey);
      const count = stage ? pipeline[stage.key] ?? 0 : 0;
      return {
        icon: Layers,
        href: stage ? `/separacao?tab=${stage.tab}` : "/separacao",
        title: `${count} pedido(s) concentrados em ${stage?.label ?? "Separação"}`,
        description: "A etapa com maior acúmulo vira o próximo foco natural da operação.",
        cta: stage ? `Abrir ${stage.label}` : "Abrir separação",
        panelClassName: "border-blue-200 bg-blue-50/80 dark:border-blue-800 dark:bg-blue-950/20",
        iconClassName: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
      };
    }

    return null;
  }, [alerts, bottleneckKey, pipeline]);

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
                  onClick={() => {
                    setActiveGalpao(g.id || null);
                  }}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    (activeGalpaoId ?? "") === g.id
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
        {recommendedAction && (
          <section className={cn("rounded-xl border p-4", recommendedAction.panelClassName)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl", recommendedAction.iconClassName)}>
                  <recommendedAction.icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ink-faint">
                    Ação recomendada
                  </p>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink">
                    {recommendedAction.title}
                  </h2>
                  <p className="mt-1 text-sm text-ink-muted">
                    {recommendedAction.description}
                  </p>
                </div>
              </div>

              <Link
                href={recommendedAction.href}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-paper transition-colors hover:opacity-90"
              >
                {recommendedAction.cta}
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </section>
        )}

        {/* ── KPI Cards ──────────────────────────────────────────────────── */}
        <section className="grid grid-cols-3 gap-3">
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

        {/* ── Throughput + Alerts ─────────────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-2">
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
            <ThroughputChart buckets={throughput.buckets} currentHour={currentBrtHour} />
          </section>

          {/* Alerts */}
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
                          {formatRelative(clockTime.getTime(), err.timestamp)}
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
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-4">
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

function ThroughputChart({
  buckets,
  currentHour,
}: {
  buckets: { hour: number; count: number }[];
  currentHour: number;
}) {
  const max = Math.max(...buckets.map((b) => b.count), 1);

  // Show 6h..current+1 range for relevance
  const endHour = Math.min(23, Math.max(currentHour + 1, 18));
  const visible = buckets.filter((b) => b.hour >= 6 && b.hour <= endHour);

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
