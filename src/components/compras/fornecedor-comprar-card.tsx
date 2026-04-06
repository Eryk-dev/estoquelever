"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Loader2,
  Package,
  Pencil,
  ShoppingCart,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { sisoFetch } from "@/lib/auth-context";
import { agingBadgeClass, agingColor, formatAging } from "./compras-helpers";
import { QtyInput } from "./qty-input";
import { ItemContextMenu } from "./item-context-menu";
import { IndisponivelDialog } from "./indisponivel-dialog";
import { CancelamentoDialog } from "./cancelamento-dialog";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PedidoRef {
  pedido_id: string;
  numero: string;
  cliente_nome: string;
  quantidade: number;
  aging_dias: number;
  item_id: string;
}

interface ComprarSkuEntry {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_necessaria: number;
  aging_dias: number;
  pedidos: PedidoRef[];
}

interface FornecedorComprarGroup {
  fornecedor: string;
  galpao_sugerido_nome: string | null;
  skus_count: number;
  pedidos_bloqueados: number;
  aging_dias: number;
  itens: ComprarSkuEntry[];
}

// ─── Dialog state ───────────────────────────────────────────────────────────

type DialogState =
  | { type: "none" }
  | { type: "indisponivel"; sku: string; itemIds: string[]; fornecedor: string }
  | { type: "cancelamento"; sku: string; itemIds: string[] };

// ─── Component ──────────────────────────────────────────────────────────────

export function FornecedorComprarCard({
  fornecedor: f,
}: {
  fornecedor: FornecedorComprarGroup;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ type: "none" });

  const [selectedSkus, setSelectedSkus] = useState<Record<string, boolean>>(
    () => Object.fromEntries(f.itens.map((i) => [i.sku, false])),
  );
  const [qtysComprar, setQtysComprar] = useState<Record<string, number>>(
    () => Object.fromEntries(f.itens.map((i) => [i.sku, i.quantidade_necessaria])),
  );
  const [submitting, setSubmitting] = useState(false);
  const lastCheckedIdx = useRef<number | null>(null);

  // Inline SKU edit state
  const [editingSkuKey, setEditingSkuKey] = useState<string | null>(null);
  const [editSkuValue, setEditSkuValue] = useState("");
  const [swappingSku, setSwappingSku] = useState(false);
  const skuInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingSkuKey && skuInputRef.current) {
      skuInputRef.current.focus();
      skuInputRef.current.select();
    }
  }, [editingSkuKey]);

  async function handleInlineSkuSwap(originalSku: string, itemIds: string[]) {
    const trimmed = editSkuValue.trim();
    if (!trimmed || trimmed === originalSku) {
      setEditingSkuKey(null);
      return;
    }
    setSwappingSku(true);
    try {
      const res = await sisoFetch("/api/compras/trocar-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: itemIds, novo_sku: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Erro ao trocar SKU");
        return;
      }
      toast.success(`SKU trocado: ${originalSku} → ${trimmed}`);
      setEditingSkuKey(null);
      invalidate();
    } catch {
      toast.error("Erro ao trocar SKU");
    } finally {
      setSwappingSku(false);
    }
  }

  const anySelected = Object.values(selectedSkus).some(Boolean);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["compras"] });
  }

  async function handleMarcarComprado() {
    const itens = Object.entries(selectedSkus)
      .filter(([, checked]) => checked)
      .map(([sku]) => ({ sku, quantidade_comprada: qtysComprar[sku] ?? 0 }));

    if (itens.length === 0) return;

    setSubmitting(true);
    try {
      const res = await sisoFetch("/api/compras/comprar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: "Erro desconhecido" }));
        throw new Error(d.error ?? "Erro ao marcar como comprado");
      }
      toast.success(`${itens.length} SKU(s) marcado(s) como comprado(s)`);
      invalidate();
      setExpanded(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao marcar");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-line border-l-4 bg-paper",
          agingColor(f.aging_dias),
        )}
      >
        {/* Header */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full px-4 py-3 text-left transition-colors hover:bg-surface/40"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">{f.fornecedor}</h3>
                {f.galpao_sugerido_nome && (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                    {f.galpao_sugerido_nome}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span className="font-medium text-amber-700">
                  {f.skus_count} SKU{f.skus_count !== 1 ? "s" : ""}
                </span>
                <span>
                  {f.pedidos_bloqueados} pedido{f.pedidos_bloqueados !== 1 ? "s" : ""} bloqueado{f.pedidos_bloqueados !== 1 ? "s" : ""}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    agingBadgeClass(f.aging_dias),
                  )}
                >
                  <Clock3 className="h-2.5 w-2.5" />
                  {formatAging(f.aging_dias)}
                </span>
              </div>
            </div>
            {expanded ? (
              <ChevronUp className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
            ) : (
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
            )}
          </div>
        </button>

        {/* Expanded */}
        {expanded && (
          <div className="border-t border-line">
            {/* Section header */}
            <div className="flex items-center justify-between bg-amber-50/60 px-4 py-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                Para Comprar
              </h4>
              {f.itens.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    const allSelected = f.itens.every((i) => selectedSkus[i.sku]);
                    setSelectedSkus((prev) => {
                      const next = { ...prev };
                      for (const i of f.itens) next[i.sku] = !allSelected;
                      return next;
                    });
                  }}
                  className="text-[10px] font-medium text-amber-700 hover:text-amber-900"
                >
                  {f.itens.every((i) => selectedSkus[i.sku])
                    ? "Desmarcar todos"
                    : "Selecionar todos"}
                </button>
              )}
            </div>

            {/* Items */}
            <div className="divide-y divide-line/60">
              {f.itens.map((item, idx) => {
                const checked = Boolean(selectedSkus[item.sku]);
                const firstItemId = item.pedidos[0]?.item_id;
                const allItemIds = item.pedidos.map((p) => p.item_id);

                return (
                  <div key={item.sku} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {/* Checkbox */}
                      <button
                        type="button"
                        onClick={(e) => {
                          if (e.shiftKey && lastCheckedIdx.current !== null) {
                            const start = Math.min(lastCheckedIdx.current, idx);
                            const end = Math.max(lastCheckedIdx.current, idx);
                            setSelectedSkus((prev) => {
                              const next = { ...prev };
                              for (let i = start; i <= end; i++) {
                                next[f.itens[i].sku] = true;
                              }
                              return next;
                            });
                          } else {
                            setSelectedSkus((prev) => ({
                              ...prev,
                              [item.sku]: !prev[item.sku],
                            }));
                          }
                          lastCheckedIdx.current = idx;
                        }}
                        className={cn(
                          "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                          checked
                            ? "border-ink bg-ink text-paper"
                            : "border-line bg-paper hover:border-ink/40",
                        )}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </button>

                      {/* Image */}
                      {item.imagem_url ? (
                        <img
                          src={item.imagem_url}
                          alt={item.sku}
                          className="h-10 w-10 shrink-0 rounded-lg border border-line object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-dashed border-line bg-surface text-ink-faint">
                          <Package className="h-4 w-4" />
                        </div>
                      )}

                      {/* Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {editingSkuKey === item.sku ? (
                            <div className="flex items-center gap-1">
                              <input
                                ref={skuInputRef}
                                type="text"
                                value={editSkuValue}
                                onChange={(e) => setEditSkuValue(e.target.value.toUpperCase())}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleInlineSkuSwap(item.sku, allItemIds);
                                  if (e.key === "Escape") setEditingSkuKey(null);
                                }}
                                disabled={swappingSku}
                                className="w-28 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs font-bold text-ink outline-none focus:border-ink/30"
                              />
                              <button
                                type="button"
                                onClick={() => handleInlineSkuSwap(item.sku, allItemIds)}
                                disabled={swappingSku}
                                className="text-emerald-600 hover:text-emerald-500"
                                title="Confirmar"
                              >
                                {swappingSku ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSkuKey(null)}
                                disabled={swappingSku}
                                className="text-ink-faint hover:text-ink"
                                title="Cancelar"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <>
                              <span className="font-mono text-sm font-semibold text-ink">
                                {item.sku}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSkuKey(item.sku);
                                  setEditSkuValue(item.sku);
                                }}
                                className="text-ink-faint transition-colors hover:text-ink"
                                title="Trocar SKU"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            </>
                          )}
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                            {item.quantidade_necessaria} un
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-ink-muted">
                          {item.descricao}
                        </p>

                        {/* Pedidos */}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {item.pedidos.map((p) => (
                            <span
                              key={p.item_id}
                              className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-ink-muted"
                            >
                              <span className="font-medium">#{p.numero}</span>
                              <span className="text-ink-faint">·</span>
                              <span className="max-w-[80px] truncate">{p.cliente_nome}</span>
                              <span className="text-ink-faint">·</span>
                              <span>{p.quantidade}un</span>
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Qty + Menu */}
                      <div className="flex shrink-0 items-start gap-1.5">
                        <QtyInput
                          value={qtysComprar[item.sku] ?? item.quantidade_necessaria}
                          onChange={(v) =>
                            setQtysComprar((prev) => ({ ...prev, [item.sku]: v }))
                          }
                          min={1}
                        />
                        <ItemContextMenu
                          onIndisponivel={() =>
                            setDialog({
                              type: "indisponivel",
                              sku: item.sku,
                              itemIds: allItemIds,
                              fornecedor: f.fornecedor,
                            })
                          }
                          onCancelar={() =>
                            setDialog({
                              type: "cancelamento",
                              sku: item.sku,
                              itemIds: allItemIds,
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            {anySelected && (
              <div className="border-t border-line bg-surface/30 px-4 py-3">
                <button
                  type="button"
                  onClick={handleMarcarComprado}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShoppingCart className="h-3.5 w-3.5" />
                  )}
                  Marcar como comprado
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialogs */}
      {dialog.type === "indisponivel" && (
        <IndisponivelDialog
          itemIds={dialog.itemIds}
          sku={dialog.sku}
          fornecedor={dialog.fornecedor}
          onClose={() => setDialog({ type: "none" })}
          onSuccess={() => {
            setDialog({ type: "none" });
            invalidate();
          }}
        />
      )}
      {dialog.type === "cancelamento" && (
        <CancelamentoDialog
          itemIds={dialog.itemIds}
          sku={dialog.sku}
          onClose={() => setDialog({ type: "none" })}
          onSuccess={() => {
            setDialog({ type: "none" });
            invalidate();
          }}
        />
      )}
    </>
  );
}
