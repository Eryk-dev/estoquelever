"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { ArrowRight, Plus, Trash2 } from "lucide-react";

interface Item {
  produto_id?: string;
  sku?: string;
  qty: number;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function TransferirPage() {
  const [empresa_id, setEmpresa] = useState<string | undefined>();
  const [origem, setOrigem] = useState<{ galpao_id?: string; localizacao_id?: string }>({});
  const [destino, setDestino] = useState<{ galpao_id?: string; localizacao_id?: string }>({});
  const [itens, setItens] = useState<Item[]>([]);

  async function resolverSku(s: string, idx: number) {
    const json = (await (
      await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)
    ).json()) as { rows?: ProdutoMin[] };
    if (!json.rows?.[0]) {
      toast.error(`SKU não encontrado`);
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
      sisoFetch("/api/wms/transferir-galpao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_id,
          galpao_origem_id: origem.galpao_id,
          localizacao_origem_id: origem.localizacao_id,
          galpao_destino_id: destino.galpao_id,
          localizacao_destino_id: destino.localizacao_id,
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
      toast.success("transferência registrada");
      setItens([]);
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-lg font-medium">Transferir entre galpões</h1>
      <QuadruplaPicker
        value={{ empresa_id, ...origem }}
        onChange={(v) => {
          setEmpresa(v.empresa_id);
          setOrigem({ galpao_id: v.galpao_id, localizacao_id: v.localizacao_id });
        }}
      />
      <ArrowRight className="w-4 h-4 mx-auto" />
      <QuadruplaPicker
        value={{ empresa_id, ...destino }}
        onChange={(v) => {
          setEmpresa(v.empresa_id);
          setDestino({ galpao_id: v.galpao_id, localizacao_id: v.localizacao_id });
        }}
      />

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
          !empresa_id ||
          !origem.localizacao_id ||
          !destino.localizacao_id ||
          itens.length === 0 ||
          submit.isPending
        }
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        {submit.isPending ? "salvando..." : "registrar transferência"}
      </button>
    </div>
  );
}
