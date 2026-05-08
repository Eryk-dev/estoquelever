"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown } from "lucide-react";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

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
  const queryClient = useQueryClient();
  const [pedidoId, setPedidoId] = useState("");
  const [original, setOriginal] = useState<Quadrupla>({});
  const [substituto, setSubstituto] = useState<Quadrupla>({});
  const [qty, setQty] = useState(1);
  const [motivo, setMotivo] = useState("");

  async function buscarSku(sku: string, setQ: (id: string) => void) {
    try {
      const r = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(sku)}&limit=1`,
      );
      if (r.rows?.[0]) setQ(r.rows[0].id);
      else toast.error("SKU não encontrado");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>("/api/wms/troca-sku", {
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
      }),
    onSuccess: () => {
      toast.success("Troca registrada");
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <input
        value={pedidoId}
        onChange={(e) => setPedidoId(e.target.value)}
        placeholder="ID do pedido"
        className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
      />

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          SKU original (estorna reserva)
        </h3>
        <input
          placeholder="SKU original"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v)
                buscarSku(v, (id) =>
                  setOriginal((prev) => ({ ...prev, produto_id: id })),
                );
            }
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v)
              buscarSku(v, (id) =>
                setOriginal((prev) => ({ ...prev, produto_id: id })),
              );
          }}
          className="w-48 rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
        <QuadruplaPicker
          value={original}
          onChange={(v) =>
            setOriginal((prev) => ({
              ...prev,
              empresa_id: v.empresa_id,
              galpao_id: v.galpao_id,
              localizacao_id: v.localizacao_id,
            }))
          }
        />
      </section>

      <div className="flex justify-center">
        <ArrowDown className="h-4 w-4 text-ink-faint" />
      </div>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          SKU substituto (cria reserva)
        </h3>
        <input
          placeholder="SKU substituto"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v)
                buscarSku(v, (id) =>
                  setSubstituto((prev) => ({ ...prev, produto_id: id })),
                );
            }
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v)
              buscarSku(v, (id) =>
                setSubstituto((prev) => ({ ...prev, produto_id: id })),
              );
          }}
          className="w-48 rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
        <QuadruplaPicker
          value={substituto}
          onChange={(v) =>
            setSubstituto((prev) => ({
              ...prev,
              empresa_id: v.empresa_id,
              galpao_id: v.galpao_id,
              localizacao_id: v.localizacao_id,
            }))
          }
        />
      </section>

      <div className="flex flex-wrap gap-2">
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-24 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm tabular-nums text-ink focus:border-ink focus:outline-none"
        />
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="motivo"
          className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
      </div>

      <button
        type="button"
        onClick={() => submit.mutate()}
        disabled={
          !pedidoId ||
          !original.produto_id ||
          !substituto.produto_id ||
          submit.isPending
        }
        className="btn-primary"
      >
        {submit.isPending ? "Salvando..." : "Trocar"}
      </button>
    </div>
  );
}
