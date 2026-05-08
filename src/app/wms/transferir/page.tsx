"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, Plus, Trash2 } from "lucide-react";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

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
  const queryClient = useQueryClient();
  const [empresa_id, setEmpresa] = useState<string | undefined>();
  const [origem, setOrigem] = useState<{
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [destino, setDestino] = useState<{
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [itens, setItens] = useState<Item[]>([]);

  async function resolverSku(s: string, idx: number) {
    try {
      const json = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (!json.rows?.[0]) {
        toast.error("SKU não encontrado");
        return;
      }
      const p = json.rows[0];
      setItens((prev) =>
        prev.map((x, i) =>
          i === idx ? { ...x, produto_id: p.id, sku: p.sku } : x,
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>("/api/wms/transferir-galpao", {
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
      }),
    onSuccess: () => {
      toast.success("Transferência registrada");
      setItens([]);
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mesmaLocalizacao =
    origem.localizacao_id &&
    destino.localizacao_id &&
    origem.localizacao_id === destino.localizacao_id;

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          Origem
        </h2>
        <QuadruplaPicker
          value={{ empresa_id, ...origem }}
          onChange={(v) => {
            setEmpresa(v.empresa_id);
            setOrigem({
              galpao_id: v.galpao_id,
              localizacao_id: v.localizacao_id,
            });
          }}
        />
      </section>

      <div className="flex justify-center">
        <ArrowDown className="h-4 w-4 text-ink-faint" />
      </div>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          Destino
        </h2>
        <QuadruplaPicker
          value={{ empresa_id, ...destino }}
          onChange={(v) => {
            setEmpresa(v.empresa_id);
            setDestino({
              galpao_id: v.galpao_id,
              localizacao_id: v.localizacao_id,
            });
          }}
        />
        {mesmaLocalizacao && (
          <p className="text-xs text-warning">
            Origem e destino estão na mesma localização — use Replenishment se for o caso.
          </p>
        )}
      </section>

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div
            key={idx}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-2.5"
          >
            <input
              placeholder="SKU"
              defaultValue={it.sku ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v && !it.produto_id) resolverSku(v, idx);
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !it.produto_id) resolverSku(v, idx);
              }}
              className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <input
              type="number"
              min={1}
              value={it.qty}
              onChange={(e) =>
                setItens((p) =>
                  p.map((x, i) =>
                    i === idx ? { ...x, qty: Number(e.target.value) } : x,
                  ),
                )
              }
              className="w-20 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm tabular-nums text-ink focus:border-ink focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setItens((p) => p.filter((_, i) => i !== idx))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-danger"
              title="Remover"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setItens((p) => [...p, { qty: 1 }])}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-ink-muted transition-colors hover:border-ink hover:text-ink"
        >
          <Plus className="h-4 w-4" /> adicionar
        </button>
      </div>

      <button
        type="button"
        onClick={() => submit.mutate()}
        disabled={
          !empresa_id ||
          !origem.localizacao_id ||
          !destino.localizacao_id ||
          mesmaLocalizacao ||
          itens.length === 0 ||
          submit.isPending
        }
        className="btn-primary"
      >
        {submit.isPending ? "Salvando..." : "Registrar transferência"}
      </button>
    </div>
  );
}
