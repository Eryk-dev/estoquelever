"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { ArrowDown } from "lucide-react";

interface Quadrupla {
  produto_id?: string;
  empresa_id?: string;
  galpao_id?: string;
  localizacao_id?: string;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function TrocaSkuPage() {
  const [pedidoId, setPedidoId] = useState("");
  const [original, setOriginal] = useState<Quadrupla>({});
  const [substituto, setSubstituto] = useState<Quadrupla>({});
  const [qty, setQty] = useState(1);
  const [motivo, setMotivo] = useState("");

  async function buscarSku(sku: string, set: (id: string) => void) {
    const r = (await (
      await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(sku)}&limit=1`)
    ).json()) as { rows?: ProdutoMin[] };
    if (r.rows?.[0]) set(r.rows[0].id);
    else toast.error("SKU não encontrado");
  }

  const submit = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/troca-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_id: pedidoId,
          qty,
          motivo,
          quadrupla_original: {
            produto_id: original.produto_id,
            empresa_dona_id: original.empresa_id,
            galpao_id: original.galpao_id,
            localizacao_id: original.localizacao_id,
          },
          quadrupla_substituto: {
            produto_id: substituto.produto_id,
            empresa_dona_id: substituto.empresa_id,
            galpao_id: substituto.galpao_id,
            localizacao_id: substituto.localizacao_id,
          },
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => toast.success("troca registrada"),
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3 max-w-2xl">
      <h1 className="text-lg font-medium">Troca de SKU na separação</h1>
      <input
        value={pedidoId}
        onChange={(e) => setPedidoId(e.target.value)}
        placeholder="ID do pedido"
        className="w-full px-2 py-1 rounded border bg-transparent"
      />

      <div>
        <h3 className="text-sm font-medium">SKU original (estorna reserva)</h3>
        <input
          placeholder="SKU original"
          onBlur={(e) =>
            e.target.value &&
            buscarSku(e.target.value, (id) =>
              setOriginal((prev) => ({ ...prev, produto_id: id })),
            )
          }
          className="w-40 px-2 py-1 rounded border bg-transparent font-mono mb-2"
        />
        <QuadruplaPicker
          value={original}
          onChange={(v) => setOriginal((prev) => ({ ...prev, ...v }))}
        />
      </div>

      <ArrowDown className="w-4 h-4 mx-auto" />

      <div>
        <h3 className="text-sm font-medium">SKU substituto (cria reserva)</h3>
        <input
          placeholder="SKU substituto"
          onBlur={(e) =>
            e.target.value &&
            buscarSku(e.target.value, (id) =>
              setSubstituto((prev) => ({ ...prev, produto_id: id })),
            )
          }
          className="w-40 px-2 py-1 rounded border bg-transparent font-mono mb-2"
        />
        <QuadruplaPicker
          value={substituto}
          onChange={(v) => setSubstituto((prev) => ({ ...prev, ...v }))}
        />
      </div>

      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-24 px-2 py-1 rounded border bg-transparent"
        />
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="motivo"
          className="flex-1 px-2 py-1 rounded border bg-transparent"
        />
      </div>

      <button
        onClick={() => submit.mutate()}
        disabled={
          !pedidoId || !original.produto_id || !substituto.produto_id
        }
        className="px-4 py-2 rounded bg-zinc-900 text-white"
      >
        trocar
      </button>
    </div>
  );
}
