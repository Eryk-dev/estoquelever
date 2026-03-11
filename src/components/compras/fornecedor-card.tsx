"use client";

import { useState } from "react";
import { Copy, Loader2, Package, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import type { CompraItemAgrupado } from "@/types";

interface FornecedorCardProps {
  fornecedor: string;
  empresa_id: string | null;
  itens: CompraItemAgrupado[];
  usuario_id: string;
  cargo: string;
}

export function FornecedorCard({
  fornecedor,
  empresa_id,
  itens,
  usuario_id,
  cargo,
}: FornecedorCardProps) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [observacao, setObservacao] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const totalItens = itens.reduce((sum, i) => sum + i.quantidade_total, 0);

  async function handleCopiar() {
    const text = itens
      .map((i) => `${i.sku}\t${i.descricao}\t${i.quantidade_total}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("SKUs copiados para a área de transferência");
    } catch {
      toast.error("Erro ao copiar");
    }
  }

  async function handleComprar() {
    if (!empresa_id) {
      toast.error("Empresa não identificada para este fornecedor");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/compras/ordens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fornecedor,
          empresa_id,
          observacao: observacao.trim() || undefined,
          usuario_id,
          cargo,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Erro desconhecido" }));
        throw new Error(data.error ?? "Erro ao criar OC");
      }
      const data = await res.json();
      toast.success(
        `OC criada com ${data.itens_vinculados} ite${data.itens_vinculados !== 1 ? "ns" : "m"}`,
      );
      setShowForm(false);
      setObservacao("");
      queryClient.invalidateQueries({ queryKey: ["compras"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar OC");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-paper overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-surface/50">
        <div className="flex items-center gap-2 min-w-0">
          <Package className="h-4 w-4 text-ink-faint shrink-0" />
          <h3 className="text-sm font-semibold text-ink truncate">
            {fornecedor}
          </h3>
          <span className="text-xs text-ink-faint">
            {itens.length} SKU{itens.length !== 1 ? "s" : ""} &middot;{" "}
            {totalItens} un
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopiar}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface hover:text-ink transition-colors"
          title="Copiar SKUs"
        >
          <Copy className="h-3.5 w-3.5" />
          Copiar
        </button>
      </div>

      {/* Items */}
      <div className="divide-y divide-line/50">
        {itens.map((item) => {
          const isExpanded = expandedSku === item.sku;
          const hasManyPedidos = item.pedidos.length > 1;
          return (
            <div key={item.sku} className="px-4 py-2.5">
              <div
                className={cn(
                  "flex items-start justify-between gap-3",
                  hasManyPedidos && "cursor-pointer",
                )}
                onClick={
                  hasManyPedidos
                    ? () =>
                        setExpandedSku(isExpanded ? null : item.sku)
                    : undefined
                }
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink truncate">
                    {item.sku}
                  </p>
                  <p className="text-xs text-ink-muted truncate">
                    {item.descricao}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-sm font-semibold text-ink tabular-nums">
                    {item.quantidade_total}un
                  </span>
                  <div className="flex flex-wrap gap-1 justify-end max-w-[140px]">
                    {item.pedidos.map((p) => (
                      <span
                        key={p.pedido_id}
                        className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                      >
                        #{p.numero_pedido}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {/* Expanded pedido breakdown */}
              {isExpanded && hasManyPedidos && (
                <div className="mt-2 ml-1 space-y-1">
                  {item.pedidos.map((p) => (
                    <div
                      key={p.pedido_id}
                      className="flex items-center justify-between text-xs text-ink-muted"
                    >
                      <span>Pedido #{p.numero_pedido}</span>
                      <span className="tabular-nums">{p.quantidade}un</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer / Action */}
      <div className="border-t border-line px-4 py-3">
        {!showForm ? (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-ink/90"
          >
            <ShoppingCart className="h-4 w-4" />
            Marcar como Comprado
          </button>
        ) : (
          <div className="space-y-3">
            <textarea
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Observação (opcional)..."
              rows={2}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleComprar}
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShoppingCart className="h-4 w-4" />
                )}
                Confirmar Compra
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setObservacao("");
                }}
                disabled={submitting}
                className="rounded-lg px-3 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
