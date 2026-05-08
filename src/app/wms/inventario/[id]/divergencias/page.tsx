"use client";
import { use } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";

interface DivergenciaRow {
  id: string;
  produto?: { sku: string; descricao?: string };
  localizacao?: { codigo?: string };
  saldo_sistema: number;
  qty_contada_final: number;
  delta: number;
  delta_pct: number | null;
  valor_financeiro: number | null;
  status: string;
}

export default function DivergenciasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-inv-div", id],
    queryFn: () =>
      wmsApi<{ rows: DivergenciaRow[] }>(
        `/api/wms/inventario/${id}/divergencias`,
      ),
  });

  const resolver = useMutation({
    mutationFn: ({
      divergencia_id,
      acao,
    }: {
      divergencia_id: string;
      acao: "aprovar" | "rejeitar" | "recontar";
    }) =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/divergencias`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ divergencia_id, acao }),
      }),
    onSuccess: () => {
      toast.success("Divergência atualizada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message="Sem divergências para essa sessão." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="p-2">SKU</th>
                <th>localização</th>
                <th className="text-right">esperado</th>
                <th className="text-right">contado</th>
                <th className="text-right">delta</th>
                <th className="text-right">%</th>
                <th>R$</th>
                <th>status</th>
                <th className="p-2">ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-t border-line">
                  <td className="p-2 font-mono text-xs text-ink">
                    {d.produto?.sku}
                  </td>
                  <td className="text-ink-muted">{d.localizacao?.codigo}</td>
                  <td className="text-right tabular-nums text-ink">
                    {d.saldo_sistema}
                  </td>
                  <td className="text-right tabular-nums text-ink">
                    {d.qty_contada_final}
                  </td>
                  <td
                    className={`text-right tabular-nums ${
                      d.delta > 0
                        ? "text-success"
                        : d.delta < 0
                          ? "text-danger"
                          : "text-ink-muted"
                    }`}
                  >
                    {d.delta}
                  </td>
                  <td className="text-right tabular-nums text-ink-muted">
                    {d.delta_pct ?? "—"}%
                  </td>
                  <td className="text-right tabular-nums text-ink-muted">
                    {d.valor_financeiro?.toFixed(2) ?? "—"}
                  </td>
                  <td>
                    <span className="badge badge-oc">{d.status}</span>
                  </td>
                  <td className="space-x-1 p-2">
                    {d.status === "pendente" && (
                      <>
                        <button
                          type="button"
                          disabled={resolver.isPending}
                          onClick={() =>
                            resolver.mutate({
                              divergencia_id: d.id,
                              acao: "aprovar",
                            })
                          }
                          className="badge badge-success cursor-pointer disabled:opacity-50"
                        >
                          aprovar
                        </button>
                        <button
                          type="button"
                          disabled={resolver.isPending}
                          onClick={() =>
                            resolver.mutate({
                              divergencia_id: d.id,
                              acao: "recontar",
                            })
                          }
                          className="badge badge-warning cursor-pointer disabled:opacity-50"
                        >
                          recontar
                        </button>
                        <button
                          type="button"
                          disabled={resolver.isPending}
                          onClick={() =>
                            resolver.mutate({
                              divergencia_id: d.id,
                              acao: "rejeitar",
                            })
                          }
                          className="badge badge-danger cursor-pointer disabled:opacity-50"
                        >
                          rejeitar
                        </button>
                      </>
                    )}
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
