"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
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
    queryFn: async () =>
      (await sisoFetch("/api/admin/galpoes")).json() as Promise<{ galpoes?: GalpaoRow[] }>,
  });

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: async () => {
      if (!galpaoId) return { rows: [] as Localizacao[] };
      const r = await sisoFetch(`/api/wms/localizacoes?galpao_id=${galpaoId}`);
      return r.json() as Promise<{ rows: Localizacao[] }>;
    },
    enabled: !!galpaoId,
  });

  const criar = useMutation({
    mutationFn: async () =>
      (
        await sisoFetch("/api/wms/localizacoes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ galpao_id: galpaoId, ...novo }),
        })
      ).json(),
    onSuccess: () => {
      toast.success("localização criada");
      setNovo({ codigo: "", descricao: "", tipo: "picking" });
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4">
      <select
        value={galpaoId}
        onChange={(e) => setGalpaoId(e.target.value)}
        className="px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
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
          <div className="flex gap-2 items-center p-3 rounded border border-zinc-200 dark:border-zinc-800">
            <input
              value={novo.codigo}
              onChange={(e) => setNovo({ ...novo, codigo: e.target.value })}
              placeholder="código (ex: A-12-03)"
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm"
            />
            <input
              value={novo.descricao}
              onChange={(e) => setNovo({ ...novo, descricao: e.target.value })}
              placeholder="descrição (opcional)"
              className="flex-1 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
            />
            <select
              value={novo.tipo}
              onChange={(e) =>
                setNovo({ ...novo, tipo: e.target.value as TipoLocalizacao })
              }
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
            >
              {TIPOS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              onClick={() => criar.mutate()}
              disabled={!novo.codigo || criar.isPending}
              className="px-3 py-1 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm"
            >
              criar
            </button>
          </div>

          <div className="space-y-1">
            {locs?.rows.map((l) => (
              <div
                key={l.id}
                className="flex items-center gap-3 p-2 rounded border border-zinc-200 dark:border-zinc-800"
              >
                <span className="font-mono text-sm">{l.codigo}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">
                  {l.tipo}
                </span>
                <span className="flex-1 text-sm text-zinc-500">{l.descricao}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
