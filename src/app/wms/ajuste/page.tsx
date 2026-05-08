"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function AjustePage() {
  const [q, setQ] = useState<{
    empresa_id?: string;
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [produto_id, setProduto] = useState<string | undefined>();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [direcao, setDirecao] = useState<"entrada" | "saida">("saida");
  const [motivo, setMotivo] = useState("");

  async function buscar(s: string) {
    const r = (await (
      await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)
    ).json()) as { rows?: ProdutoMin[] };
    if (r.rows?.[0]) {
      setProduto(r.rows[0].id);
      setSku(r.rows[0].sku);
    } else {
      toast.error("SKU não encontrado");
    }
  }

  const submit = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/ajuste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quadrupla: { produto_id, ...q },
          qty,
          direcao,
          motivo,
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("ajuste registrado");
      setQty(1);
      setMotivo("");
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3 max-w-2xl">
      <h1 className="text-lg font-medium">Ajuste manual de estoque</h1>
      <QuadruplaPicker value={q} onChange={setQ} />
      <div className="flex gap-2 flex-wrap">
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          onBlur={(e) => e.target.value && buscar(e.target.value)}
          placeholder="SKU/GTIN"
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono"
        />
        <select
          value={direcao}
          onChange={(e) => setDirecao(e.target.value as "entrada" | "saida")}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        >
          <option value="entrada">+ entrada</option>
          <option value="saida">− saída</option>
        </select>
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-24 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        />
      </div>
      <textarea
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="motivo (avaria, perda, encontro, erro de contagem...)"
        className="w-full px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        rows={3}
      />
      <button
        onClick={() => submit.mutate()}
        disabled={
          !produto_id || !q.localizacao_id || motivo.length < 3 || submit.isPending
        }
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        registrar ajuste
      </button>
    </div>
  );
}
