"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";

interface RetroativoRow {
  id: string;
  criado_em: string;
  quantidade: number;
  observacoes: string | null;
  produto: { sku: string; descricao: string } | null;
  empresa: { nome: string } | null;
  galpao: { nome: string } | null;
  localizacao: { codigo: string } | null;
}

export default function RetroativosPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-retroativos"],
    queryFn: () =>
      wmsApi<{ rows: RetroativoRow[] }>("/api/wms/lancamento-retroativo"),
  });

  const reconciliar = useMutation({
    mutationFn: ({ id, compraId }: { id: string; compraId: string }) =>
      wmsApi<{ ok: true }>(`/api/wms/lancamento-retroativo/${id}/reconciliar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compra_mov_id: compraId }),
      }),
    onSuccess: () => {
      toast.success("Reconciliado");
      queryClient.invalidateQueries({ queryKey: ["wms-retroativos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Entradas registradas em emergência aguardando match com NF formal.
      </p>
      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message="Nenhuma pendência de reconciliação." />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.id}
              className="space-y-1 rounded-xl border border-line bg-paper p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-mono text-sm text-ink">{r.produto?.sku}</span>
                  <span className="ml-2 text-sm text-ink-muted truncate">
                    {r.produto?.descricao}
                  </span>
                </div>
                <div className="text-sm tabular-nums text-ink">
                  {Number(r.quantidade).toLocaleString("pt-BR")} un
                </div>
              </div>
              <div className="text-xs text-ink-faint">
                {r.empresa?.nome} · {r.galpao?.nome} · {r.localizacao?.codigo} ·{" "}
                {new Date(r.criado_em).toLocaleString("pt-BR")}
              </div>
              {r.observacoes && (
                <div className="text-xs text-ink-muted">{r.observacoes}</div>
              )}
              <input
                placeholder="UUID da movimentação de compra"
                disabled={reconciliar.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = (e.target as HTMLInputElement).value.trim();
                    if (v) reconciliar.mutate({ id: r.id, compraId: v });
                  }
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v) reconciliar.mutate({ id: r.id, compraId: v });
                }}
                className="w-full rounded-lg border border-line bg-paper px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none disabled:opacity-50"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
