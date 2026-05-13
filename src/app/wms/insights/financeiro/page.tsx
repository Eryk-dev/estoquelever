"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import { fmtBRL } from "@/components/wms/ui/wms-ui";
import { InsightsStrip } from "@/components/wms/insights/insights-strip";
import type { FinanceiroValor, InsightAtivo } from "@/lib/wms/insights/types";

interface Emprestimo {
  credora_id: string;
  devedora_id: string;
  produto_id: string;
  devido: number;
}

interface Response {
  valor: FinanceiroValor[];
  emprestimos: Emprestimo[];
  ajustes_recentes: Array<{
    usuario_id: string | null;
    tipo: string;
    quantidade: number;
    custo_unitario: number | null;
    criado_em: string;
  }>;
  insights: InsightAtivo[];
}

export default function FinanceiroPage() {
  const { activeGalpaoId, user } = useAuth();
  const sp = new URLSearchParams();
  if (activeGalpaoId) sp.set("galpao_id", activeGalpaoId);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "financeiro", activeGalpaoId],
    queryFn: () => wmsApi<Response>(`/api/wms/insights/financeiro?${sp}`),
    enabled: user?.cargo === "admin",
  });

  if (user?.cargo !== "admin") {
    return (
      <div className="rounded-xl border border-line bg-paper p-6 text-center">
        <p className="text-sm text-ink-muted">Acesso restrito a administradores.</p>
      </div>
    );
  }

  if (isLoading) return <LoadingSpinner />;
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  const totalGeral = data.valor.reduce((s, v) => s + v.valor_total, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Financeiro</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Valor do estoque, empréstimos entre empresas, ajustes manuais (admin only).
        </p>
      </div>

      <InsightsStrip insights={data.insights} emptyMessage="Sem alertas financeiros." />

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Valor de estoque por empresa × galpão</h2>
        <p className="mt-1 text-xs text-ink-faint">Total geral: {fmtBRL(totalGeral)}</p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="py-2 text-left">Empresa</th>
              <th className="py-2 text-left">Galpão</th>
              <th className="py-2 text-right">SKUs</th>
              <th className="py-2 text-right">Valor total</th>
              <th className="py-2 text-right">Curva A</th>
              <th className="py-2 text-right">Curva B</th>
              <th className="py-2 text-right">Curva C</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.valor.map((v) => (
              <tr key={`${v.empresa_dona_id}-${v.galpao_id}`} className="hover:bg-surface/60">
                <td className="py-2 font-semibold">{v.empresa_nome}</td>
                <td className="py-2 text-ink-muted">{v.galpao_nome}</td>
                <td className="py-2 text-right font-mono tabular-nums">{v.qtd_skus}</td>
                <td className="py-2 text-right font-mono tabular-nums">{fmtBRL(v.valor_total)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{fmtBRL(v.valor_curva_a)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{fmtBRL(v.valor_curva_b)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{fmtBRL(v.valor_curva_c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Empréstimos entre empresas (saldo devedor)</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Quantidade líquida que cada empresa deve pra outra, agrupado por produto.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="py-2 text-left">Devedora</th>
              <th className="py-2 text-left">Credora</th>
              <th className="py-2 text-right">Produto</th>
              <th className="py-2 text-right">Qty devida</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.emprestimos.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-ink-faint">
                  Sem saldos devedores.
                </td>
              </tr>
            )}
            {data.emprestimos.map((e, i) => (
              <tr key={i} className="hover:bg-surface/60">
                <td className="py-2 font-mono text-xs">{e.devedora_id.slice(0, 8)}</td>
                <td className="py-2 font-mono text-xs">{e.credora_id.slice(0, 8)}</td>
                <td className="py-2 text-right font-mono text-xs">{e.produto_id.slice(0, 8)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{e.devido}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Ajustes manuais (últimos 30d)</h2>
        <p className="mt-1 text-xs text-ink-faint">
          {data.ajustes_recentes.length} ajustes registrados.
        </p>
      </section>
    </div>
  );
}
