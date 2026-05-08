"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, RefreshCw } from "lucide-react";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { Produto } from "@/lib/wms/types";

export default function ProdutosPage() {
  const [q, setQ] = useState("");
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-produtos", q],
    queryFn: () =>
      wmsApi<{ rows: Produto[]; total: number }>(
        `/api/wms/produtos?q=${encodeURIComponent(q)}`,
      ),
  });

  const sync = useMutation({
    mutationFn: (id: string) =>
      wmsApi<{ ok: true }>(`/api/wms/produtos/${id}/sync`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Sincronizado");
      queryClient.invalidateQueries({ queryKey: ["wms-produtos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3 py-2 focus-within:border-ink">
        <Search className="h-4 w-4 text-ink-faint" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="SKU, descrição ou GTIN"
          className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
      </div>
      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={q ? "Nenhum produto encontrado." : "Nenhum produto cadastrado."} />
      ) : (
        <div className="space-y-1">
          {rows.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm text-ink">{p.sku}</div>
                <div className="truncate text-sm text-ink-muted">{p.descricao}</div>
                <div className="text-xs text-ink-faint">
                  {p.gtin && <>GTIN: {p.gtin} · </>}
                  {p.ncm && <>NCM: {p.ncm} · </>}
                  {p.sincronizado_em
                    ? `sync: ${new Date(p.sincronizado_em).toLocaleString("pt-BR")}`
                    : "nunca sincronizado"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => sync.mutate(p.id)}
                disabled={sync.isPending}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
                title="Sincronizar com Tiny"
              >
                <RefreshCw
                  className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
