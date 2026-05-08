"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function AjustePage() {
  const queryClient = useQueryClient();
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
    try {
      const r = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (r.rows?.[0]) {
        setProduto(r.rows[0].id);
        setSku(r.rows[0].sku);
      } else {
        toast.error("SKU não encontrado");
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>("/api/wms/ajuste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quadrupla: { produto_id, ...q },
          qty,
          direcao,
          motivo,
        }),
      }),
    onSuccess: () => {
      toast.success("Ajuste registrado");
      setQty(1);
      setMotivo("");
      setProduto(undefined);
      setSku("");
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const motivoTooShort = motivo.length > 0 && motivo.length < 3;

  return (
    <div className="space-y-4">
      <QuadruplaPicker value={q} onChange={setQ} />

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-3">
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) buscar(v);
            }
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v) buscar(v);
          }}
          placeholder="SKU/GTIN"
          className="rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
        <select
          value={direcao}
          onChange={(e) => setDirecao(e.target.value as "entrada" | "saida")}
          className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
        >
          <option value="entrada">+ entrada</option>
          <option value="saida">− saída</option>
        </select>
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-24 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm tabular-nums text-ink focus:border-ink focus:outline-none"
        />
      </div>

      <div className="space-y-1">
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="motivo (avaria, perda, encontro, erro de contagem...)"
          className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
          rows={3}
        />
        <p className="text-xs text-ink-faint">
          Motivo obrigatório (mínimo 3 caracteres).
        </p>
        {motivoTooShort && (
          <p className="text-xs text-warning">Muito curto, escreva mais detalhes.</p>
        )}
      </div>

      <button
        type="button"
        onClick={() => submit.mutate()}
        disabled={
          !produto_id ||
          !q.localizacao_id ||
          motivo.length < 3 ||
          submit.isPending
        }
        className="btn-primary"
      >
        {submit.isPending ? "Salvando..." : "Registrar ajuste"}
      </button>
    </div>
  );
}
