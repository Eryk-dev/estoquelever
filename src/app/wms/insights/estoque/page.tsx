"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import { fmtBRL, fmtNum } from "@/components/wms/ui/wms-ui";
import { InsightsStrip } from "@/components/wms/insights/insights-strip";
import { KpiCard } from "@/components/wms/insights/kpi-card";
import type {
  EstoqueQuadrantePonto,
  InsightAtivo,
} from "@/lib/wms/insights/types";

interface Response {
  quadrante: EstoqueQuadrantePonto[];
  insights: InsightAtivo[];
  distribuicaoStatus: Record<string, number>;
  slowMovers: Array<{ titulo: string; descricao: string; dados: Record<string, number> }>;
}

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  atencao: "Atenção",
  critico: "Crítico",
  lead_time_risco: "Risco lead-time",
  sem_giro: "Sem giro",
};

export default function EstoquePage() {
  const { activeGalpaoId } = useAuth();
  const sp = new URLSearchParams();
  if (activeGalpaoId) sp.set("galpao_id", activeGalpaoId);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "estoque", activeGalpaoId],
    queryFn: () => wmsApi<Response>(`/api/wms/insights/estoque?${sp}`),
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  const valorTotal = data.quadrante.reduce((s, r) => s + (r.valor || 0), 0);
  const curvaCount = data.quadrante.reduce(
    (acc, r) => ({ ...acc, [r.curva]: (acc[r.curva] || 0) + 1 }),
    { A: 0, B: 0, C: 0 } as Record<string, number>,
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">
          Estoque — saúde, cobertura e capital
        </h1>
        <p className="mt-1 text-sm text-ink-muted">ABC, cobertura por giro, ruptura iminente, slow-movers.</p>
      </div>

      <InsightsStrip insights={data.insights} emptyMessage="Estoque saudável no momento." />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="SKUs ativos" value={fmtNum(data.quadrante.length)} sub="com saldo > 0" />
        <KpiCard label="Curva A" value={fmtNum(curvaCount.A)} sub="top 20% do giro" />
        <KpiCard
          label="Crítico/Risco"
          value={fmtNum(
            (data.distribuicaoStatus.critico || 0) + (data.distribuicaoStatus.lead_time_risco || 0),
          )}
          tone="bad"
        />
        <KpiCard label="Capital total" value={fmtBRL(valorTotal)} />
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Distribuição por status de cobertura</h2>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {Object.entries(STATUS_LABEL).map(([k, label]) => (
            <div key={k} className="rounded-lg border border-line bg-surface p-3">
              <p className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
              <p className="mt-1 font-mono text-lg font-bold tabular-nums">
                {data.distribuicaoStatus[k] ?? 0}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-paper">
        <div className="border-b border-line p-3">
          <h2 className="text-sm font-semibold text-ink">Top 30 por valor empatado</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">Curva</th>
              <th className="px-3 py-2 text-right">Saldo</th>
              <th className="px-3 py-2 text-right">Giro/d</th>
              <th className="px-3 py-2 text-right">Cobertura</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.quadrante.slice(0, 30).map((r) => (
              <tr key={r.produto_id} className="hover:bg-surface/60">
                <td className="px-3 py-2 font-mono text-xs">{r.sku}</td>
                <td className="px-3 py-2 font-semibold">{r.curva}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{r.saldo}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{r.giro_diario?.toFixed(2) ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {r.dias_cobertura !== null ? `${r.dias_cobertura.toFixed(1)}d` : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtBRL(r.valor)}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">{STATUS_LABEL[r.status_cobertura]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
