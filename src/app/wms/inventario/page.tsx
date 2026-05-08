"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";

interface SessaoRow {
  id: string;
  tipo: string;
  status: string;
  galpao?: { nome?: string };
}

interface GalpaoRow {
  id: string;
  nome: string;
}

interface LocRow {
  id: string;
  codigo: string;
}

interface NovoSessao {
  tipo: "cycle_count" | "completo";
  galpao_id: string;
  modo_contagem: "aberto" | "blind" | "duplo_blind";
  tolerancia_pct: number;
  exige_aprovacao_acima_valor: number;
  areas: { nome: string; localizacao_ids: string[] }[];
}

const STATUS_BADGE: Record<string, string> = {
  em_andamento: "badge badge-info",
  aplicada: "badge badge-success",
  cancelada: "badge badge-danger",
  revisao: "badge badge-warning",
  aprovada: "badge badge-success",
  planejada: "badge badge-oc",
};

export default function InventarioListaPage() {
  const queryClient = useQueryClient();
  const [novo, setNovo] = useState<NovoSessao>({
    tipo: "cycle_count",
    galpao_id: "",
    modo_contagem: "blind",
    tolerancia_pct: 2,
    exige_aprovacao_acima_valor: 1000,
    areas: [],
  });

  const sessoesQuery = useQuery({
    queryKey: ["wms-inv-sessoes"],
    queryFn: () => wmsApi<{ rows: SessaoRow[] }>("/api/wms/inventario"),
  });

  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: () => wmsApi<{ galpoes?: GalpaoRow[] }>("/api/admin/galpoes"),
  });

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", novo.galpao_id],
    queryFn: () =>
      wmsApi<{ rows: LocRow[] }>(
        `/api/wms/localizacoes?galpao_id=${novo.galpao_id}`,
      ),
    enabled: !!novo.galpao_id,
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<{ id: string }>("/api/wms/inventario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(novo),
      }),
    onSuccess: () => {
      toast.success("Sessão criada");
      setNovo((p) => ({ ...p, areas: [] }));
      queryClient.invalidateQueries({ queryKey: ["wms-inv-sessoes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function adicionarArea(localizacao_ids: string[]) {
    setNovo((p) => ({
      ...p,
      areas: [
        ...p.areas,
        { nome: `Área ${p.areas.length + 1}`, localizacao_ids },
      ],
    }));
  }

  const rows = sessoesQuery.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <details className="rounded-xl border border-line bg-paper">
        <summary className="cursor-pointer p-3 text-sm font-medium text-ink">
          Criar nova sessão
        </summary>
        <div className="space-y-3 border-t border-line p-3">
          <div className="flex flex-wrap gap-2">
            <select
              value={novo.tipo}
              onChange={(e) =>
                setNovo({
                  ...novo,
                  tipo: e.target.value as "cycle_count" | "completo",
                })
              }
              className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
            >
              <option value="cycle_count">cycle count</option>
              <option value="completo">inventário completo</option>
            </select>
            <select
              value={novo.galpao_id}
              onChange={(e) =>
                setNovo({ ...novo, galpao_id: e.target.value, areas: [] })
              }
              className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
            >
              <option value="">— galpão —</option>
              {galpoes?.galpoes?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
            <select
              value={novo.modo_contagem}
              onChange={(e) =>
                setNovo({
                  ...novo,
                  modo_contagem: e.target.value as NovoSessao["modo_contagem"],
                })
              }
              className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
            >
              <option value="aberto">aberto</option>
              <option value="blind">blind</option>
              <option value="duplo_blind">duplo blind</option>
            </select>
            <input
              type="number"
              step="0.5"
              value={novo.tolerancia_pct}
              onChange={(e) =>
                setNovo({ ...novo, tolerancia_pct: Number(e.target.value) })
              }
              className="w-24 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
              placeholder="tol %"
            />
          </div>

          {novo.galpao_id && (
            <div>
              <button
                type="button"
                onClick={() =>
                  adicionarArea((locs?.rows ?? []).map((l) => l.id))
                }
                className="btn-ghost text-sm"
              >
                adicionar todas localizações como Área 1
              </button>
              <div className="mt-2 text-sm text-ink-muted">
                {novo.areas.length} área(s) configurada(s)
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => criar.mutate()}
            disabled={!novo.galpao_id || novo.areas.length === 0 || criar.isPending}
            className="btn-primary"
          >
            criar sessão
          </button>
        </div>
      </details>

      {sessoesQuery.isLoading ? (
        <LoadingSpinner />
      ) : sessoesQuery.isError ? (
        <ErrorBanner
          message={(sessoesQuery.error as Error).message}
          onRetry={() => sessoesQuery.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState message="Nenhuma sessão de inventário criada ainda." />
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <Link
              key={s.id}
              href={`/wms/inventario/${s.id}`}
              className="block rounded-xl border border-line bg-paper p-3 transition-colors hover:bg-surface"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-ink-faint">
                    {s.id.slice(0, 8)}
                  </span>
                  <span className="ml-2 text-sm text-ink">
                    {s.tipo} · {s.galpao?.nome}
                  </span>
                </div>
                <span className={STATUS_BADGE[s.status] ?? "badge badge-oc"}>
                  {s.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
