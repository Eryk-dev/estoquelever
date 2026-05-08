"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

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
  const queryClient = useQueryClient();
  const [base, setBase] = useState<{ empresa_id?: string; galpao_id?: string }>({});
  const [nf, setNf] = useState("");
  const [itens, setItens] = useState<Item[]>([]);

  async function resolverProdutoESugestao(skuOuGtin: string, idx: number) {
    if (!base.empresa_id || !base.galpao_id) {
      toast.error("Escolha empresa e galpão antes");
      return;
    }
    try {
      const json = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(skuOuGtin)}&limit=1`,
      );
      const p = json.rows?.[0];
      if (!p) {
        toast.error(`SKU não encontrado: ${skuOuGtin}`);
        return;
      }
      const sug = await wmsApi<PutawaySugestao>(
        `/api/wms/receber?produto_id=${p.id}&empresa_id=${base.empresa_id}&galpao_id=${base.galpao_id}`,
      );
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
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () => {
      const naoResolvidos = itens.filter((i) => !i.produto_id || !i.localizacao_id);
      if (naoResolvidos.length > 0) {
        throw new Error(
          `${naoResolvidos.length} item(ns) sem SKU/localização resolvidos`,
        );
      }
      return wmsApi<{ ok: true }>("/api/wms/receber", {
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
      });
    },
    onSuccess: () => {
      toast.success("Estoque recebido");
      setItens([]);
      setNf("");
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
      queryClient.invalidateQueries({ queryKey: ["wms-cobertura"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
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
        className="w-72 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
      />

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div
            key={idx}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-2.5"
          >
            <input
              placeholder="bipe SKU/GTIN"
              defaultValue={it.sku ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v && !it.produto_id) resolverProdutoESugestao(v, idx);
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !it.produto_id) resolverProdutoESugestao(v, idx);
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
              className="w-24 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm tabular-nums text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            {it.localizacao_codigo && (
              <span className="text-xs text-ink-faint">
                → {it.localizacao_codigo} ({it.putawayRazao})
              </span>
            )}
            <button
              type="button"
              onClick={() => setItens((p) => p.filter((_, i) => i !== idx))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-danger"
              title="Remover item"
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
          <Plus className="h-4 w-4" /> adicionar item
        </button>
      </div>

      <button
        type="button"
        onClick={() => submit.mutate()}
        disabled={!base.empresa_id || itens.length === 0 || submit.isPending}
        className="btn-primary"
      >
        {submit.isPending ? "Salvando..." : "Registrar recebimento"}
      </button>
    </div>
  );
}
