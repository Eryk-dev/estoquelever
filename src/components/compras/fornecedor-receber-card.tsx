"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Clock3,
  Loader2,
  Package,
  PackageCheck,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { sisoFetch } from "@/lib/auth-context";
import { agingBadgeClass, formatAging } from "./compras-helpers";
import { ProductImageZoom } from "@/components/ui/product-image-zoom";
import { QtyInput } from "./qty-input";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PedidoRef {
  pedido_id: string;
  numero: string;
  cliente_nome: string;
  quantidade: number;
  aging_dias: number;
  item_id: string;
}

interface ReceberSkuEntry {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_comprada: number;
  quantidade_recebida: number;
  quantidade_pendente: number;
  aging_dias: number;
  comprado_em: string | null;
  pedidos: PedidoRef[];
}

interface FornecedorReceberGroup {
  fornecedor: string;
  galpao_sugerido_nome: string | null;
  skus_count: number;
  pendente_count: number;
  aging_dias: number;
  itens: ReceberSkuEntry[];
}

// ─── Component ──────────────────────────────────────────────────────────────

export function FornecedorReceberCard({
  fornecedor: f,
}: {
  fornecedor: FornecedorReceberGroup;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [qtysReceber, setQtysReceber] = useState<Record<string, number>>(
    () => Object.fromEntries(f.itens.map((i) => [i.sku, 0])),
  );

  const anyToReceive = Object.values(qtysReceber).some((v) => v > 0);

  function handleReceberTodos() {
    const allFilled = f.itens.every((i) => (qtysReceber[i.sku] ?? 0) > 0);
    setQtysReceber((prev) => {
      const next = { ...prev };
      for (const i of f.itens) {
        next[i.sku] = allFilled ? 0 : Math.max(i.quantidade_pendente, i.quantidade_comprada);
      }
      return next;
    });
  }

  async function handleConfirmarRecebimento() {
    const itens = Object.entries(qtysReceber)
      .filter(([, qty]) => qty > 0)
      .map(([sku, quantidade_recebida]) => ({ sku, quantidade_recebida }));

    if (itens.length === 0) return;

    setSubmitting(true);
    try {
      const res = await sisoFetch("/api/compras/receber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: "Erro desconhecido" }));
        throw new Error(d.error ?? "Erro ao confirmar recebimento");
      }
      toast.success("Recebimento confirmado");
      queryClient.invalidateQueries({ queryKey: ["compras"] });
      setExpanded(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao confirmar recebimento");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line border-l-4 border-l-sky-400 bg-paper">
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
              <span className="font-medium text-sky-700">
                {f.pendente_count} {f.pendente_count === 1 ? "item pendente" : "itens pendentes"}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  agingBadgeClass(f.aging_dias),
                )}
              >
                <Clock3 className="h-2.5 w-2.5" />
                comprado {formatAging(f.aging_dias)}
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
          <div className="flex items-center justify-between bg-sky-50/60 px-4 py-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-sky-800">
              Conferencia de Recebimento
            </h4>
            {f.itens.length > 1 && (
              <button
                type="button"
                onClick={handleReceberTodos}
                className="text-[10px] font-medium text-sky-700 hover:text-sky-900"
              >
                {f.itens.every((i) => (qtysReceber[i.sku] ?? 0) > 0)
                  ? "Limpar todos"
                  : "Receber todos"}
              </button>
            )}
          </div>

          {/* Items */}
          <div className="divide-y divide-line/60">
            {f.itens.map((item) => {
              return (
                <div key={item.sku} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    {/* Image */}
                    {item.imagem_url ? (
                      <ProductImageZoom
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
                        <span className="font-mono text-sm font-semibold text-ink">
                          {item.sku}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        {item.descricao}
                      </p>

                      {/* Progress */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                          Comprado: {item.quantidade_comprada}
                        </span>
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                          Recebido: {item.quantidade_recebida}/{item.quantidade_comprada}
                        </span>
                        {item.quantidade_pendente > 0 && (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                            Faltam: {item.quantidade_pendente}
                          </span>
                        )}
                      </div>

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
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Qty input */}
                    <div className="shrink-0">
                      <QtyInput
                        value={qtysReceber[item.sku] ?? 0}
                        onChange={(v) =>
                          setQtysReceber((prev) => ({ ...prev, [item.sku]: v }))
                        }
                        min={0}
                        max={Math.max(item.quantidade_pendente, item.quantidade_comprada)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          {anyToReceive && (
            <div className="border-t border-line bg-surface/30 px-4 py-3">
              <button
                type="button"
                onClick={handleConfirmarRecebimento}
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PackageCheck className="h-3.5 w-3.5" />
                )}
                Confirmar recebimento
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
