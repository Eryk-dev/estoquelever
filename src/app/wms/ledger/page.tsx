"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";

interface LedgerRow {
  id: string;
  criado_em: string;
  tipo: string;
  origem_tipo: string;
  quantidade: number;
  saldo_anterior: number;
  saldo_posterior: number;
  produto?: { sku: string };
  empresa?: { nome: string };
  galpao?: { nome: string };
  localizacao?: { codigo: string };
}

const ORIGENS = [
  "compra_manual",
  "nf_venda",
  "emprestimo",
  "reserva_pedido",
  "liberacao_reserva",
  "ajuste_manual",
  "inventario",
  "inventario_inicial",
];

export default function LedgerPage() {
  const [filtros, setFiltros] = useState({ origem_tipo: "", limit: 100 });
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-ledger", filtros],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (filtros.origem_tipo) sp.set("origem_tipo", filtros.origem_tipo);
      sp.set("limit", String(filtros.limit));
      return wmsApi<{ rows: LedgerRow[] }>(`/api/wms/ledger?${sp}`);
    },
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <select
          value={filtros.origem_tipo}
          onChange={(e) => setFiltros({ ...filtros, origem_tipo: e.target.value })}
          className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
        >
          <option value="">todas origens</option>
          {ORIGENS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message="Nenhuma movimentação encontrada." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="p-2">data</th>
                <th>tipo</th>
                <th>origem</th>
                <th>SKU</th>
                <th>dona</th>
                <th>galpão</th>
                <th>loc</th>
                <th className="text-right">qty</th>
                <th className="p-2 text-right">saldo→</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="whitespace-nowrap p-2 text-ink-muted">
                    {new Date(r.criado_em).toLocaleString("pt-BR")}
                  </td>
                  <td className="font-bold text-ink">{r.tipo}</td>
                  <td className="text-ink-muted">{r.origem_tipo}</td>
                  <td className="text-ink">{r.produto?.sku}</td>
                  <td className="text-ink-muted">{r.empresa?.nome}</td>
                  <td className="text-ink-muted">{r.galpao?.nome}</td>
                  <td className="text-ink-muted">{r.localizacao?.codigo}</td>
                  <td className="text-right tabular-nums text-ink">{r.quantidade}</td>
                  <td className="p-2 text-right tabular-nums text-ink-muted">
                    {r.saldo_anterior} → {r.saldo_posterior}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
