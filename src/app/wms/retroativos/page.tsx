"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";

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
  const { data } = useQuery({
    queryKey: ["wms-retroativos"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/lancamento-retroativo")).json() as Promise<{
        rows: RetroativoRow[];
      }>,
  });

  const reconciliar = useMutation({
    mutationFn: async ({ id, compraId }: { id: string; compraId: string }) =>
      sisoFetch(`/api/wms/lancamento-retroativo/${id}/reconciliar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compra_mov_id: compraId }),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("reconciliado");
      queryClient.invalidateQueries({ queryKey: ["wms-retroativos"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-medium">Lançamentos retroativos pendentes</h1>
      <p className="text-sm text-zinc-500">
        Entradas registradas em emergência aguardando match com NF formal.
      </p>
      <div className="space-y-2">
        {data?.rows.map((r) => (
          <div
            key={r.id}
            className="p-3 rounded border border-zinc-200 dark:border-zinc-800 space-y-1"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-sm">{r.produto?.sku}</span>
                <span className="ml-2 text-zinc-500">{r.produto?.descricao}</span>
              </div>
              <div className="text-sm tabular-nums">
                {Number(r.quantidade).toLocaleString("pt-BR")} un
              </div>
            </div>
            <div className="text-xs text-zinc-500">
              {r.empresa?.nome} · {r.galpao?.nome} · {r.localizacao?.codigo} ·{" "}
              {new Date(r.criado_em).toLocaleString("pt-BR")}
            </div>
            <div className="text-xs">{r.observacoes}</div>
            <input
              placeholder="ID da mov de compra (uuid) — Enter ou foco fora envia"
              onBlur={(e) =>
                e.target.value &&
                reconciliar.mutate({ id: r.id, compraId: e.target.value })
              }
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-xs font-mono w-full"
            />
          </div>
        ))}
        {data && data.rows.length === 0 && (
          <div className="text-zinc-500 text-sm">nenhuma pendência</div>
        )}
      </div>
    </div>
  );
}
