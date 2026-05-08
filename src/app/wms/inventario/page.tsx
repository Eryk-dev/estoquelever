"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import Link from "next/link";

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

  const { data: sessoes } = useQuery({
    queryKey: ["wms-inv-sessoes"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/inventario")).json() as Promise<{
        rows: SessaoRow[];
      }>,
  });
  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: async () =>
      (await sisoFetch("/api/admin/galpoes")).json() as Promise<{
        galpoes?: GalpaoRow[];
      }>,
  });
  const { data: locs } = useQuery({
    queryKey: ["wms-locs", novo.galpao_id],
    queryFn: async () =>
      novo.galpao_id
        ? ((
            await sisoFetch(`/api/wms/localizacoes?galpao_id=${novo.galpao_id}`)
          ).json() as Promise<{ rows: LocRow[] }>)
        : { rows: [] as LocRow[] },
    enabled: !!novo.galpao_id,
  });

  const criar = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/inventario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(novo),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("sessão criada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv-sessoes"] });
    },
    onError: (e) => toast.error(String(e)),
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

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-lg font-medium">Sessões de inventário</h1>

      <details className="rounded border border-zinc-200 dark:border-zinc-800">
        <summary className="p-3 cursor-pointer">Criar nova sessão</summary>
        <div className="p-3 space-y-3">
          <div className="flex gap-2 flex-wrap">
            <select
              value={novo.tipo}
              onChange={(e) =>
                setNovo({
                  ...novo,
                  tipo: e.target.value as "cycle_count" | "completo",
                })
              }
              className="px-2 py-1 rounded border bg-transparent"
            >
              <option value="cycle_count">cycle count</option>
              <option value="completo">inventário completo</option>
            </select>
            <select
              value={novo.galpao_id}
              onChange={(e) =>
                setNovo({ ...novo, galpao_id: e.target.value, areas: [] })
              }
              className="px-2 py-1 rounded border bg-transparent"
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
                  modo_contagem: e.target
                    .value as NovoSessao["modo_contagem"],
                })
              }
              className="px-2 py-1 rounded border bg-transparent"
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
              className="w-20 px-2 py-1 rounded border bg-transparent"
              placeholder="tol %"
            />
          </div>

          {novo.galpao_id && (
            <div>
              <button
                onClick={() =>
                  adicionarArea((locs?.rows ?? []).map((l) => l.id))
                }
                className="px-3 py-1 rounded border text-sm"
              >
                adicionar todas localizações como Área 1
              </button>
              <div className="mt-2 text-sm">
                {novo.areas.length} área(s) configurada(s)
              </div>
            </div>
          )}

          <button
            onClick={() => criar.mutate()}
            disabled={!novo.galpao_id || novo.areas.length === 0}
            className="px-3 py-1 rounded bg-zinc-900 text-white"
          >
            criar sessão
          </button>
        </div>
      </details>

      <div className="space-y-2">
        {sessoes?.rows?.map((s) => (
          <Link
            key={s.id}
            href={`/wms/inventario/${s.id}`}
            className="block p-3 rounded border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-xs text-zinc-500">
                  {s.id.slice(0, 8)}
                </span>
                <span className="ml-2">
                  {s.tipo} · {s.galpao?.nome}
                </span>
              </div>
              <div className="text-sm">
                <span
                  className={`px-2 py-0.5 rounded text-xs ${
                    s.status === "em_andamento"
                      ? "bg-blue-100 text-blue-900"
                      : s.status === "aplicada"
                        ? "bg-green-100 text-green-900"
                        : "bg-zinc-100"
                  }`}
                >
                  {s.status}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
