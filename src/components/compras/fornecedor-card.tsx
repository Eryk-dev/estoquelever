"use client";

import { useState } from "react";
import {
  AlertCircle,
  Building2,
  Clock3,
  Copy,
  Loader2,
  Package,
  ShoppingCart,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import type { CompraItemAgrupado } from "@/types";

interface FornecedorCardProps {
  fornecedor: string;
  empresa_id: string | null;
  empresa_nome: string | null;
  prioridade: "critica" | "alta" | "normal";
  aging_dias: number;
  pedidos_bloqueados: number;
  quantidade_total: number;
  total_skus: number;
  proxima_acao: string;
  itens: CompraItemAgrupado[];
  usuario_id: string;
  cargo: string;
}

const PRIORIDADE_META = {
  critica: {
    label: "Crítica",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  alta: {
    label: "Alta",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  normal: {
    label: "Normal",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
} as const;

function formatDaysLabel(days: number) {
  if (days <= 0) return "Hoje";
  if (days === 1) return "1 dia";
  return `${days} dias`;
}

export function FornecedorCard({
  fornecedor,
  empresa_id,
  empresa_nome,
  prioridade,
  aging_dias,
  pedidos_bloqueados,
  quantidade_total,
  total_skus,
  proxima_acao,
  itens,
  usuario_id,
  cargo,
}: FornecedorCardProps) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [observacao, setObservacao] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const prioridadeMeta = PRIORIDADE_META[prioridade];

  async function handleCopiar() {
    const lines = itens.map(
      (item) => `*${item.quantidade_total}x* ${item.sku}\n${item.descricao}`,
    );
    const empresaLabel = empresa_nome ?? "Empresa não identificada";
    const text = `*${fornecedor}* — ${empresaLabel}\n${total_skus} SKU${total_skus !== 1 ? "s" : ""} · ${quantidade_total} un\n\n${lines.join("\n\n")}`;

    try {
      await navigator.clipboard.writeText(text);
      toast.success("Lista copiada para compartilhar");
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
        `Compra confirmada: ${data.itens_vinculados} item(ns), ${data.quantidade_total ?? quantidade_total} un`,
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
    <div className="overflow-hidden rounded-2xl border border-line bg-paper">
      <div className="border-b border-line bg-[linear-gradient(135deg,rgba(245,158,11,0.10),rgba(245,158,11,0.03)_55%,rgba(255,255,255,0.92))] px-4 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                  prioridadeMeta.className,
                )}
              >
                {prioridadeMeta.label}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-paper/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted">
                <Building2 className="h-3.5 w-3.5" />
                {empresa_nome ?? "Empresa não identificada"}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Package className="h-4 w-4 text-ink-faint" />
              <h3 className="text-base font-semibold text-ink">{fornecedor}</h3>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-ink-muted">
              Próxima ação: <span className="font-medium text-ink">{proxima_acao}</span>
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[420px]">
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Fila</p>
              <p className="mt-1 text-lg font-semibold text-ink">{quantidade_total} un</p>
              <p className="text-xs text-ink-muted">{total_skus} SKU{total_skus !== 1 ? "s" : ""}</p>
            </div>
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Pedidos</p>
              <p className="mt-1 text-lg font-semibold text-ink">{pedidos_bloqueados}</p>
              <p className="text-xs text-ink-muted">bloqueados por compra</p>
            </div>
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Aging</p>
              <p className="mt-1 flex items-center gap-1 text-lg font-semibold text-ink">
                <Clock3 className="h-4 w-4 text-ink-faint" />
                {formatDaysLabel(aging_dias)}
              </p>
              <p className="text-xs text-ink-muted">desde a solicitação</p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCopiar}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper/90 px-3 py-2 text-xs font-medium text-ink hover:bg-paper"
          >
            <Copy className="h-3.5 w-3.5" />
            Copiar lista
          </button>
          {prioridade === "critica" && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
              <AlertCircle className="h-3.5 w-3.5" />
              Esta compra está segurando pedido demais para ficar parada
            </span>
          )}
        </div>
      </div>

      <div className="divide-y divide-line/60">
        {itens.map((item) => {
          const isExpanded = expandedSku === item.sku;
          const hasManyPedidos = item.pedidos.length > 1;
          return (
            <div key={item.sku} className="px-4 py-3">
              <div
                className={cn(
                  "flex items-start gap-3",
                  hasManyPedidos && "cursor-pointer",
                )}
                onClick={hasManyPedidos ? () => setExpandedSku(isExpanded ? null : item.sku) : undefined}
              >
                {item.imagem ? (
                  <img
                    src={item.imagem}
                    alt={item.sku}
                    className="h-11 w-11 shrink-0 rounded-lg border border-line bg-surface object-cover"
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-line bg-surface text-ink-faint">
                    <Package className="h-4 w-4" />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{item.sku}</p>
                    <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                      {item.quantidade_total} un
                    </span>
                    <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                      {item.pedidos_bloqueados} pedido{item.pedidos_bloqueados !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{item.descricao}</p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    Solicitado há {formatDaysLabel(item.aging_dias)}
                  </p>
                </div>

                <div className="flex max-w-[180px] flex-wrap justify-end gap-1">
                  {item.pedidos.map((pedido) => (
                    <span
                      key={pedido.pedido_id}
                      className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                    >
                      #{pedido.numero_pedido}
                    </span>
                  ))}
                </div>
              </div>

              {isExpanded && hasManyPedidos && (
                <div className="mt-3 grid gap-2 rounded-xl border border-line bg-surface/40 p-3">
                  {item.pedidos.map((pedido) => (
                    <div
                      key={pedido.pedido_id}
                      className="flex items-center justify-between text-xs text-ink-muted"
                    >
                      <span>Pedido #{pedido.numero_pedido}</span>
                      <span className="font-medium text-ink">{pedido.quantidade} un</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-line px-4 py-4">
        {!showForm ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-muted">
              Quando a compra for efetivamente fechada, marque aqui para abrir a trilha de conferência.
            </p>
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink/90"
            >
              <ShoppingCart className="h-4 w-4" />
              Compra confirmada
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <textarea
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Observação rápida da compra (opcional)"
              rows={2}
              className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none resize-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleComprar}
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShoppingCart className="h-4 w-4" />
                )}
                Confirmar compra
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setObservacao("");
                }}
                disabled={submitting}
                className="rounded-lg px-3 py-2 text-sm text-ink-muted hover:text-ink"
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
