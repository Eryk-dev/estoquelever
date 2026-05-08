"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { SaldoPerspectivaTabs } from "@/components/wms/saldo-perspectiva-tabs";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { PerspectivaEstoque } from "@/lib/wms/types";

interface ItemRow {
  produto: { sku: string; descricao: string };
  empresa: { nome: string };
  galpao: { nome: string };
  localizacao: { codigo: string };
  saldo: number;
  reservado: number;
  disponivel: number;
}

interface AgregadoRow {
  chave: string;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  itens: ItemRow[];
}

export default function EstoquePage() {
  const [view, setView] = useState<PerspectivaEstoque>("produto");
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-estoque", view],
    queryFn: () => wmsApi<{ rows: AgregadoRow[] }>(`/api/wms/estoque?view=${view}`),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <SaldoPerspectivaTabs value={view} onChange={setView} />
      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message="Sem saldo nessa perspectiva." />
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <details
              key={r.chave}
              className="rounded-xl border border-line bg-paper"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-3 p-3">
                <span className="font-medium text-ink">{r.nome}</span>
                <span className="text-sm tabular-nums text-ink-muted">
                  {r.disponivel.toLocaleString("pt-BR")} disp ·{" "}
                  {r.reservado.toLocaleString("pt-BR")} res ·{" "}
                  {r.saldo.toLocaleString("pt-BR")} total
                </span>
              </summary>
              <div className="space-y-1 border-t border-line p-3 text-xs">
                {r.itens.map((i, idx) => (
                  <div
                    key={idx}
                    className="flex gap-3 font-mono text-ink-muted"
                  >
                    <span>{i.produto.sku}</span>
                    <span>{i.empresa.nome}</span>
                    <span>{i.galpao.nome}</span>
                    <span>{i.localizacao.codigo}</span>
                    <span className="ml-auto tabular-nums text-ink">{i.saldo}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
