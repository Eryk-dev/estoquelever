"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import { InsightsStrip } from "@/components/wms/insights/insights-strip";
import type { DevolucaoAgregado, InsightAtivo } from "@/lib/wms/insights/types";

interface Response {
  agregado: DevolucaoAgregado[];
  recentes: Array<{
    id: string;
    status: string;
    classificacao: string | null;
    criado_em: string;
    classificada_em: string | null;
    observacoes: string | null;
    nota_fiscal_id: number | null;
    pedido_origem_id: string | null;
  }>;
  insights: InsightAtivo[];
}

const CLASSIF_LABEL: Record<string, string> = {
  integro: "A — Íntegro (volta ao estoque)",
  avariado: "B — Avariado (baixa)",
  garantia: "C — Garantia (RMA)",
  troca_sku: "D — Troca SKU",
  pendente: "Aguardando classificação",
};

export default function DevolucoesPage() {
  const { activeGalpaoId } = useAuth();
  const sp = new URLSearchParams();
  if (activeGalpaoId) sp.set("galpao_id", activeGalpaoId);
  sp.set("dias", "30");

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "devolucoes", activeGalpaoId],
    queryFn: () => wmsApi<Response>(`/api/wms/insights/devolucoes?${sp}`),
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  const total = data.agregado.reduce((s, a) => s + a.qtd, 0);
  const pendentes = data.agregado.reduce((s, a) => s + a.qtd_pendentes, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">
          Devoluções — análise de retorno
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Distribuição por classificação A/B/C/D nos últimos 30 dias.
        </p>
      </div>

      <InsightsStrip insights={data.insights} emptyMessage="Sem alertas de devolução." />

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-paper p-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">Total 30d</p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">{total}</p>
        </div>
        <div className="rounded-xl border border-line bg-paper p-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            Aguardando classificação
          </p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">{pendentes}</p>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Distribuição por classificação</h2>
        <div className="mt-3 space-y-2">
          {data.agregado.map((a) => {
            const pct = total > 0 ? Math.round((a.qtd / total) * 100) : 0;
            return (
              <div key={a.classificacao} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">
                    {CLASSIF_LABEL[a.classificacao] ?? a.classificacao}
                  </span>
                  <span className="text-xs text-ink-muted">
                    <strong>{a.qtd}</strong> ({pct}%)
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-surface">
                  <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Devoluções recentes</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="py-2 text-left">Data</th>
              <th className="py-2 text-left">Status</th>
              <th className="py-2 text-left">Classificação</th>
              <th className="py-2 text-left">Pedido</th>
              <th className="py-2 text-left">Obs.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.recentes.slice(0, 30).map((r) => (
              <tr key={r.id} className="hover:bg-surface/60">
                <td className="py-2 text-xs">{new Date(r.criado_em).toLocaleDateString("pt-BR")}</td>
                <td className="py-2 text-xs text-ink-muted">{r.status}</td>
                <td className="py-2 text-xs">{r.classificacao ?? "—"}</td>
                <td className="py-2 font-mono text-xs">{r.pedido_origem_id ?? "—"}</td>
                <td className="py-2 text-xs text-ink-faint">{r.observacoes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
