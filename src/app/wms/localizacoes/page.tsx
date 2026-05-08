"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { Localizacao, TipoLocalizacao } from "@/lib/wms/types";

const TIPOS: TipoLocalizacao[] = [
  "picking",
  "overstock",
  "recebimento",
  "expedicao",
  "quarentena",
];

interface GalpaoRow {
  id: string;
  nome: string;
}

export default function LocalizacoesPage() {
  const queryClient = useQueryClient();
  const [galpaoId, setGalpaoId] = useState<string>("");
  const [novo, setNovo] = useState({
    codigo: "",
    descricao: "",
    tipo: "picking" as TipoLocalizacao,
  });

  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: () => wmsApi<{ galpoes?: GalpaoRow[] }>("/api/admin/galpoes"),
  });

  const locsQuery = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: () =>
      wmsApi<{ rows: Localizacao[] }>(
        `/api/wms/localizacoes?galpao_id=${galpaoId}`,
      ),
    enabled: !!galpaoId,
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<Localizacao>("/api/wms/localizacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ galpao_id: galpaoId, ...novo }),
      }),
    onSuccess: () => {
      toast.success("Localização criada");
      setNovo({ codigo: "", descricao: "", tipo: "picking" });
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = locsQuery.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <select
        value={galpaoId}
        onChange={(e) => setGalpaoId(e.target.value)}
        className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
      >
        <option value="">— escolha o galpão —</option>
        {galpoes?.galpoes?.map((g) => (
          <option key={g.id} value={g.id}>
            {g.nome}
          </option>
        ))}
      </select>

      {galpaoId && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-3">
            <input
              value={novo.codigo}
              onChange={(e) => setNovo({ ...novo, codigo: e.target.value })}
              placeholder="código (ex: A-12-03)"
              className="rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <input
              value={novo.descricao}
              onChange={(e) => setNovo({ ...novo, descricao: e.target.value })}
              placeholder="descrição (opcional)"
              className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <select
              value={novo.tipo}
              onChange={(e) =>
                setNovo({ ...novo, tipo: e.target.value as TipoLocalizacao })
              }
              className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
            >
              {TIPOS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => criar.mutate()}
              disabled={!novo.codigo || criar.isPending}
              className="btn-primary"
            >
              criar
            </button>
          </div>

          {locsQuery.isLoading ? (
            <LoadingSpinner />
          ) : locsQuery.isError ? (
            <ErrorBanner
              message={(locsQuery.error as Error).message}
              onRetry={() => locsQuery.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState message="Nenhuma localização criada nesse galpão." />
          ) : (
            <div className="space-y-1">
              {rows.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center gap-3 rounded-xl border border-line bg-paper p-2.5"
                >
                  <span className="font-mono text-sm text-ink">{l.codigo}</span>
                  <span className="badge badge-info">{l.tipo}</span>
                  <span className="flex-1 text-sm text-ink-muted">{l.descricao}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
