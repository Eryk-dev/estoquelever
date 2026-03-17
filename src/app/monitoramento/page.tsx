"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
  TrendingUp,
  Webhook,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/app-shell";
import { formatRelativeTime, formatMs } from "@/lib/domain-helpers";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MonitoringData {
  generatedAt: string;
  orders: {
    today: {
      pendente: number;
      concluido: number;
      cancelado: number;
      erro: number;
    };
    total: number;
  };
  webhooks: {
    last24h: {
      received: number;
      processed: number;
      errors: number;
      pending: number;
    };
    avgProcessingMs: number | null;
    throughputPerHour: { hour: string; count: number }[];
    errorRate: number;
  };
  recentErrors: {
    id: string;
    timestamp: string;
    source: string;
    message: string;
    metadata: Record<string, unknown>;
    pedido_id: string | null;
    filial: string | null;
  }[];
  health: {
    lastWebhookReceivedAt: string | null;
    lastSuccessfulProcessingAt: string | null;
    status: "healthy" | "warning" | "degraded";
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatHour(hour: string): string {
  // hour format: "2026-03-09T14"
  const parts = hour.split("T");
  if (parts.length !== 2) return hour;
  return `${parts[1]}h`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <Icon className={cn("h-4 w-4", color)} />
      </div>
      <p className="text-2xl font-bold tracking-tight text-ink">{value}</p>
      {sub && <p className="text-[11px] text-ink-faint">{sub}</p>}
    </div>
  );
}

function HealthBadge({ status }: { status: MonitoringData["health"]["status"] }) {
  const cfg = {
    healthy: {
      cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
      dot: "bg-emerald-500",
      label: "Saudável",
    },
    warning: {
      cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
      dot: "bg-amber-500",
      label: "Atenção",
    },
    degraded: {
      cls: "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400",
      dot: "bg-red-500",
      label: "Degradado",
    },
  }[status];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        cfg.cls,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
    </span>
  );
}

function ThroughputChart({
  data,
}: {
  data: { hour: string; count: number }[];
}) {
  const max = Math.max(...data.map((d) => d.count), 1);

  // Show last 12 hours
  const visible = data.slice(-12);

  return (
    <div className="space-y-2">
      <div className="flex h-20 items-end gap-0.5">
        {visible.map((bucket) => {
          const pct = (bucket.count / max) * 100;
          return (
            <div
              key={bucket.hour}
              className="group relative flex flex-1 flex-col items-center justify-end"
            >
              <div
                className="w-full rounded-t bg-blue-400/70 transition-all dark:bg-blue-500/60"
                style={{ height: `${Math.max(pct, bucket.count > 0 ? 4 : 0)}%` }}
              />
              {/* Tooltip */}
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
          {visible[0] ? formatHour(visible[0].hour) : ""}
        </span>
        <span className="text-[10px] text-ink-faint">
          {visible[visible.length - 1]
            ? formatHour(visible[visible.length - 1].hour)
            : ""}
        </span>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MonitoramentoPage() {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/monitoring");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar dados");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh every 30s
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const headerRight = (
    <>
      {data && <HealthBadge status={data.health.status} />}
      <button
        type="button"
        onClick={() => {
          setLoading(true);
          fetchData();
        }}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
      >
        <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        Atualizar
      </button>
    </>
  );

  return (
    <AppShell
      title="Monitoramento"
      subtitle="Logs, webhooks e saúde do sistema"
      backHref="/configuracoes"
      requireAdmin={true}
      headerRight={headerRight}
      mainClassName="space-y-6"
    >
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {data && (
        <>
          {/* ── System Health ──────────────────────────────────────────── */}
          <section className="rounded-xl border border-line bg-paper px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="h-4 w-4 text-ink-faint" />
              <h2 className="text-sm font-semibold text-ink">
                Saude do Sistema
              </h2>
              {lastRefreshed && (
                <span className="ml-auto text-[10px] text-ink-faint">
                  Atualizado {formatRelativeTime(lastRefreshed.toISOString())}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="space-y-0.5">
                <p className="text-[11px] text-ink-faint">Ultimo webhook</p>
                <p className="text-sm font-medium text-ink">
                  {formatRelativeTime(data.health.lastWebhookReceivedAt)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-[11px] text-ink-faint">Ultimo processamento OK</p>
                <p className="text-sm font-medium text-ink">
                  {formatRelativeTime(data.health.lastSuccessfulProcessingAt)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-[11px] text-ink-faint">Taxa de erro (24h)</p>
                <p
                  className={cn(
                    "text-sm font-medium",
                    data.webhooks.errorRate >= 50
                      ? "text-red-600 dark:text-red-400"
                      : data.webhooks.errorRate >= 20
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {data.webhooks.errorRate}%
                </p>
              </div>
            </div>
          </section>

          {/* ── Stat Cards ─────────────────────────────────────────────── */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Pedidos hoje"
              value={data.orders.total}
              sub={`${data.orders.today.pendente} pendentes`}
              icon={TrendingUp}
              color="text-blue-500"
            />
            <StatCard
              label="Webhooks (24h)"
              value={data.webhooks.last24h.received}
              sub={`${data.webhooks.last24h.processed} processados`}
              icon={Webhook}
              color="text-indigo-500"
            />
            <StatCard
              label="Tempo medio"
              value={formatMs(data.webhooks.avgProcessingMs)}
              sub="por processamento"
              icon={Clock}
              color="text-amber-500"
            />
            <StatCard
              label="Erros (24h)"
              value={data.webhooks.last24h.errors}
              sub={`${data.webhooks.last24h.pending} processando`}
              icon={XCircle}
              color={
                data.webhooks.last24h.errors > 0
                  ? "text-red-500"
                  : "text-ink-faint"
              }
            />
          </section>

          {/* ── Orders Today ───────────────────────────────────────────── */}
          <section className="rounded-xl border border-line bg-paper px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-ink-faint" />
              <h2 className="text-sm font-semibold text-ink">
                Pedidos Hoje
              </h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(
                [
                  { key: "pendente", label: "Pendente", color: "text-amber-600 dark:text-amber-400" },
                  { key: "concluido", label: "Concluido", color: "text-emerald-600 dark:text-emerald-400" },
                  { key: "cancelado", label: "Cancelado", color: "text-ink-muted" },
                  { key: "erro", label: "Erro", color: "text-red-600 dark:text-red-400" },
                ] as const
              ).map(({ key, label, color }) => (
                <div
                  key={key}
                  className="flex flex-col items-center justify-center rounded-lg bg-zinc-50 py-3 dark:bg-zinc-800/50"
                >
                  <p className={cn("text-xl font-bold", color)}>
                    {data.orders.today[key]}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink-faint">{label}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── Webhook Throughput ─────────────────────────────────────── */}
          <section className="rounded-xl border border-line bg-paper px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
              <Webhook className="h-4 w-4 text-ink-faint" />
              <h2 className="text-sm font-semibold text-ink">
                Volume de Webhooks (ultimas 12h)
              </h2>
            </div>
            {data.webhooks.throughputPerHour.length > 0 ? (
              <ThroughputChart data={data.webhooks.throughputPerHour} />
            ) : (
              <p className="text-xs text-ink-faint">Nenhum dado disponivel.</p>
            )}
          </section>

          {/* ── Recent Errors ──────────────────────────────────────────── */}
          <section className="rounded-xl border border-line bg-paper px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-400" />
              <h2 className="text-sm font-semibold text-ink">
                Erros Recentes
              </h2>
              <span className="ml-auto text-[11px] text-ink-faint">
                ultimos 10
              </span>
            </div>
            {data.recentErrors.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-3 dark:bg-emerald-950/30">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <p className="text-sm text-emerald-700 dark:text-emerald-400">
                  Nenhum erro registrado.
                </p>
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-line">
                {data.recentErrors.map((err) => (
                  <div key={err.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-600 dark:bg-red-950/40 dark:text-red-400">
                            {err.source}
                          </span>
                          {err.filial && (
                            <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted dark:bg-zinc-800 dark:text-zinc-400">
                              {err.filial}
                            </span>
                          )}
                          {err.pedido_id && (
                            <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted dark:bg-zinc-800 dark:text-zinc-400">
                              #{err.pedido_id}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-ink">
                          {err.message}
                        </p>
                        {err.metadata &&
                          Object.keys(err.metadata).length > 0 && (
                            <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
                              {JSON.stringify(err.metadata)}
                            </p>
                          )}
                      </div>
                      <span className="shrink-0 text-[11px] text-ink-faint">
                        {formatRelativeTime(err.timestamp)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
