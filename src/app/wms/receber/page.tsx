"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { Plus, Trash2 } from "lucide-react";

interface Item {
  produto_id?: string;
  sku?: string;
  qty: number;
  custo_unitario?: number;
  localizacao_id?: string;
  localizacao_codigo?: string;
  putawayRazao?: string;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

interface PutawaySugestao {
  localizacao_id: string;
  codigo?: string;
  razao: string;
}

export default function ReceberPage() {
  const [base, setBase] = useState<{ empresa_id?: string; galpao_id?: string }>({});
  const [nf, setNf] = useState("");
  const [itens, setItens] = useState<Item[]>([]);

  async function resolverProdutoESugestao(skuOuGtin: string, idx: number) {
    const r = await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(skuOuGtin)}&limit=1`);
    const json = (await r.json()) as { rows?: ProdutoMin[] };
    const p = json.rows?.[0];
    if (!p) {
      toast.error(`SKU não encontrado: ${skuOuGtin}`);
      return;
    }
    if (!base.empresa_id || !base.galpao_id) {
      toast.error("escolha empresa+galpão antes");
      return;
    }
    const sug = (await (
      await sisoFetch(
        `/api/wms/receber?produto_id=${p.id}&empresa_id=${base.empresa_id}&galpao_id=${base.galpao_id}`,
      )
    ).json()) as PutawaySugestao;

    setItens((prev) =>
      prev.map((it, i) =>
        i === idx
          ? {
              ...it,
              produto_id: p.id,
              sku: p.sku,
              localizacao_id: sug.localizacao_id,
              localizacao_codigo: sug.codigo,
              putawayRazao: sug.razao,
            }
          : it,
      ),
    );
  }

  const submit = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/receber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_dona_id: base.empresa_id,
          galpao_id: base.galpao_id,
          nf_referencia: nf || undefined,
          itens: itens.map((i) => ({
            produto_id: i.produto_id,
            qty: i.qty,
            custo_unitario: i.custo_unitario,
            localizacao_id: i.localizacao_id,
          })),
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("estoque recebido");
      setItens([]);
      setNf("");
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-lg font-medium">Receber estoque</h1>
      <QuadruplaPicker
        value={base}
        onChange={(v) =>
          setBase({ empresa_id: v.empresa_id, galpao_id: v.galpao_id })
        }
        showLocalizacao={false}
      />
      <input
        value={nf}
        onChange={(e) => setNf(e.target.value)}
        placeholder="NF de referência (opcional)"
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent w-64"
      />

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div
            key={idx}
            className="flex gap-2 items-center p-2 rounded border border-zinc-200 dark:border-zinc-800"
          >
            <input
              placeholder="bipe SKU/GTIN"
              defaultValue={it.sku ?? ""}
              onBlur={(e) =>
                e.target.value && !it.produto_id &&
                resolverProdutoESugestao(e.target.value, idx)
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
            <input
              type="number"
              step="0.01"
              placeholder="custo"
              value={it.custo_unitario ?? ""}
              onChange={(e) =>
                setItens((p) =>
                  p.map((x, i) =>
                    i === idx
                      ? {
                          ...x,
                          custo_unitario: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        }
                      : x,
                  ),
                )
              }
              className="w-24 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
            />
            {it.localizacao_codigo && (
              <span className="text-xs text-zinc-500">
                → {it.localizacao_codigo} ({it.putawayRazao})
              </span>
            )}
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
          <Plus className="w-4 h-4" /> adicionar item
        </button>
      </div>

      <button
        onClick={() => submit.mutate()}
        disabled={!base.empresa_id || itens.length === 0 || submit.isPending}
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        {submit.isPending ? "salvando..." : "registrar recebimento"}
      </button>
    </div>
  );
}
