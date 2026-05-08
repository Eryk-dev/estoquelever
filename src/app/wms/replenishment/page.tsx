"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { ArrowDown, Plus, Trash2 } from "lucide-react";

interface Item {
  produto_id?: string;
  sku?: string;
  qty: number;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

interface EmpresaRow {
  id: string;
  nome: string;
  galpao_id: string;
}

interface GalpaoRow {
  id: string;
  nome: string;
  empresas?: EmpresaRow[];
}

interface LocRow {
  id: string;
  codigo: string;
  tipo: string;
}

export default function ReplenishmentPage() {
  const [empresa_id, setEmpresa] = useState<string | undefined>();
  const [galpao_id, setGalpao] = useState<string | undefined>();
  const [origem_loc, setOrigem] = useState<string | undefined>();
  const [destino_loc, setDestino] = useState<string | undefined>();
  const [itens, setItens] = useState<Item[]>([]);

  const { data: galpoesResp } = useQuery({
    queryKey: ["galpoes"],
    queryFn: async () =>
      (await sisoFetch("/api/admin/galpoes")).json() as Promise<{ galpoes?: GalpaoRow[] }>,
  });

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpao_id],
    queryFn: async () =>
      galpao_id
        ? ((await sisoFetch(`/api/wms/localizacoes?galpao_id=${galpao_id}`)).json() as Promise<{
            rows: LocRow[];
          }>)
        : { rows: [] as LocRow[] },
    enabled: !!galpao_id,
  });

  const empresas: EmpresaRow[] = (galpoesResp?.galpoes ?? []).flatMap((g) =>
    (g.empresas ?? []).map((e) => ({ ...e, galpao_id: g.id })),
  );

  async function resolverSku(s: string, idx: number) {
    const json = (await (
      await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)
    ).json()) as { rows?: ProdutoMin[] };
    if (!json.rows?.[0]) {
      toast.error("SKU não encontrado");
      return;
    }
    setItens((p) =>
      p.map((x, i) =>
        i === idx ? { ...x, produto_id: json.rows![0].id, sku: json.rows![0].sku } : x,
      ),
    );
  }

  const submit = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/replenishment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_id,
          galpao_id,
          localizacao_origem_id: origem_loc,
          localizacao_destino_id: destino_loc,
          itens: itens.map((i) => ({ produto_id: i.produto_id, qty: i.qty })),
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("replenishment ok");
      setItens([]);
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-lg font-medium">Replenishment intra-galpão</h1>
      <div className="flex gap-2 flex-wrap">
        <select
          value={empresa_id ?? ""}
          onChange={(e) => {
            const sel = empresas.find((x) => x.id === e.target.value);
            setEmpresa(sel?.id);
            setGalpao(sel?.galpao_id);
            setOrigem(undefined);
            setDestino(undefined);
          }}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
        >
          <option value="">— empresa —</option>
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
        <select
          value={origem_loc ?? ""}
          onChange={(e) => setOrigem(e.target.value || undefined)}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
        >
          <option value="">— origem —</option>
          {locs?.rows?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.codigo} ({l.tipo})
            </option>
          ))}
        </select>
        <ArrowDown className="w-4 h-4 self-center" />
        <select
          value={destino_loc ?? ""}
          onChange={(e) => setDestino(e.target.value || undefined)}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
        >
          <option value="">— destino —</option>
          {locs?.rows
            ?.filter((l) => l.id !== origem_loc)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.codigo} ({l.tipo})
              </option>
            ))}
        </select>
      </div>

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div
            key={idx}
            className="flex gap-2 items-center p-2 rounded border border-zinc-200 dark:border-zinc-800"
          >
            <input
              placeholder="SKU"
              defaultValue={it.sku ?? ""}
              onBlur={(e) =>
                e.target.value && !it.produto_id && resolverSku(e.target.value, idx)
              }
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm flex-1"
            />
            <input
              type="number"
              min={1}
              value={it.qty}
              onChange={(e) =>
                setItens((p) =>
                  p.map((x, i) => (i === idx ? { ...x, qty: Number(e.target.value) } : x)),
                )
              }
              className="w-20 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
            />
            <button
              onClick={() => setItens((p) => p.filter((_, i) => i !== idx))}
              className="p-1"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() => setItens((p) => [...p, { qty: 1 }])}
          className="flex items-center gap-1 text-sm px-3 py-1 rounded border border-dashed border-zinc-400"
        >
          <Plus className="w-4 h-4" /> adicionar
        </button>
      </div>

      <button
        onClick={() => submit.mutate()}
        disabled={
          !empresa_id || !origem_loc || !destino_loc || itens.length === 0 || submit.isPending
        }
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        {submit.isPending ? "salvando..." : "registrar"}
      </button>
    </div>
  );
}
