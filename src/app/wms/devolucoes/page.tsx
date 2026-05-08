"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";

interface DevRow {
  id: string;
  nota_fiscal_id: number | null;
  empresa?: { nome?: string } | null;
  criado_em: string;
}

export default function DevolucoesPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-devolucoes"],
    queryFn: () => wmsApi<{ rows: DevRow[] }>("/api/wms/devolucoes"),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Aguardando chegada física e classificação pelo operador.
      </p>
      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message="Nenhuma devolução pendente." />
      ) : (
        <div className="space-y-2">
          {rows.map((d) => (
            <Link
              key={d.id}
              href={`/wms/devolucoes/${d.id}`}
              className="block rounded-xl border border-line bg-paper p-3 transition-colors hover:bg-surface"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-ink">
                    NF {d.nota_fiscal_id ?? "—"}
                  </span>
                  <span className="ml-2 truncate text-sm text-ink-muted">
                    {d.empresa?.nome}
                  </span>
                </div>
                <div className="text-xs text-ink-faint">
                  {new Date(d.criado_em).toLocaleString("pt-BR")}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
