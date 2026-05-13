"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import { InsightsStrip } from "@/components/wms/insights/insights-strip";
import type {
  FunilEtapa,
  InsightAtivo,
  LeadTimePercentil,
  ThroughputDia,
  ThroughputHora,
} from "@/lib/wms/insights/types";

interface Response {
  funil: FunilEtapa[];
  leadTime: LeadTimePercentil[];
  throughputDia: ThroughputDia[];
  throughputHora: ThroughputHora[];
  insights: InsightAtivo[];
}

const ETAPA_LABEL: Record<string, string> = {
  separacao: "Separação",
  embalagem: "Embalagem",
  guarda: "Guarda",
};

export default function FluxoPage() {
  const { activeGalpaoId } = useAuth();
  const sp = new URLSearchParams();
  if (activeGalpaoId) sp.set("galpao_id", activeGalpaoId);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "fluxo", activeGalpaoId],
    queryFn: () => wmsApi<Response>(`/api/wms/insights/fluxo?${sp}`),
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">
          Fluxo — gargalo e throughput
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Lead time, etapa por etapa, throughput diário e horário.
        </p>
      </div>

      <InsightsStrip insights={data.insights} emptyMessage="Fluxo dentro do padrão." />

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Lead time (pedido criado → embalado)</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="py-2 text-left">Período</th>
              <th className="py-2 text-right">Pedidos</th>
              <th className="py-2 text-right">Média</th>
              <th className="py-2 text-right">P50</th>
              <th className="py-2 text-right">P90</th>
              <th className="py-2 text-right">P95</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.leadTime.map((l) => (
              <tr key={l.periodo}>
                <td className="py-2 font-semibold">{l.periodo}</td>
                <td className="py-2 text-right font-mono tabular-nums">{l.qtd}</td>
                <td className="py-2 text-right font-mono tabular-nums">{l.media_min ?? "—"} min</td>
                <td className="py-2 text-right font-mono tabular-nums">{l.p50_min ?? "—"} min</td>
                <td className="py-2 text-right font-mono tabular-nums">{l.p90_min ?? "—"} min</td>
                <td className="py-2 text-right font-mono tabular-nums">{l.p95_min ?? "—"} min</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Funil por etapa</h2>
        <div className="mt-3 space-y-2">
          {data.funil.map((f) => (
            <div key={f.etapa} className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{ETAPA_LABEL[f.etapa] ?? f.etapa}</span>
                <span className="text-xs text-ink-muted">
                  Tempo médio: {f.tempo_medio_min !== null ? `${Math.round(f.tempo_medio_min)} min` : "—"} ·{" "}
                  <strong>{f.acumulado_atual}</strong> em fila
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Throughput por hora (hoje vs média 14d)</h2>
        <div className="mt-3 flex h-24 items-end gap-1">
          {data.throughputHora.map((h) => {
            const max = Math.max(...data.throughputHora.map((t) => Math.max(t.hoje, t.media_14d)), 1);
            const hojeH = Math.max((h.hoje / max) * 100, h.hoje > 0 ? 6 : 0);
            return (
              <div key={h.hora} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[9px] text-ink-faint">{h.hoje || ""}</span>
                <div className="flex h-full w-full items-end rounded-t bg-surface">
                  <div
                    className="w-full rounded-t bg-amber-500/80"
                    style={{ height: `${hojeH}%` }}
                  />
                </div>
                <span className="text-[9px] text-ink-faint">{String(h.hora).padStart(2, "0")}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Throughput diário (30d)</h2>
        <div className="mt-3 flex h-20 items-end gap-[3px]">
          {data.throughputDia.map((d) => {
            const max = Math.max(...data.throughputDia.map((t) => t.pedidos), 1);
            const h = Math.max((d.pedidos / max) * 100, d.pedidos > 0 ? 6 : 2);
            return (
              <div
                key={d.dia}
                className="flex-1 rounded-t bg-sky-400/80"
                style={{ height: `${h}%` }}
                title={`${d.dia}: ${d.pedidos}`}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
