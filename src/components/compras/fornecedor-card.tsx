"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Building2,
  Check,
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
  rascunho_ocs: number;
  itens_em_rascunho: number;
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

type SelectionPreset = "all" | "critical" | "none";

function formatDaysLabel(days: number) {
  if (days <= 0) return "Hoje";
  if (days === 1) return "1 dia";
  return `${days} dias`;
}

function isCriticalItem(item: CompraItemAgrupado) {
  return item.aging_dias >= 3 || item.pedidos_bloqueados >= 2 || item.quantidade_total >= 5;
}

function buildSelectionMap(
  itens: CompraItemAgrupado[],
  preset: SelectionPreset,
): Record<string, boolean> {
  return Object.fromEntries(
    itens.map((item) => [
      item.sku,
      preset === "all" ? true : preset === "critical" ? isCriticalItem(item) : false,
    ]),
  );
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
  rascunho_ocs,
  itens_em_rascunho,
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
  const [selectedSkus, setSelectedSkus] = useState<Record<string, boolean>>(() =>
    buildSelectionMap(itens, "all"),
  );

  useEffect(() => {
    setSelectedSkus((current) => {
      const next = buildSelectionMap(itens, "none");
      for (const item of itens) {
        next[item.sku] = current[item.sku] ?? true;
      }
      return next;
    });
    setExpandedSku((current) =>
      current && itens.some((item) => item.sku === current) ? current : null,
    );
  }, [itens]);

  const prioridadeMeta = PRIORIDADE_META[prioridade];
  const empresaLabel = empresa_nome ?? "Empresa não identificada";

  const selectedItems = useMemo(
    () => itens.filter((item) => selectedSkus[item.sku]),
    [itens, selectedSkus],
  );
  const selectedSkuCount = selectedItems.length;
  const selectedQuantity = selectedItems.reduce((sum, item) => sum + item.quantidade_total, 0);
  const selectedPedidoCount = new Set(
    selectedItems.flatMap((item) => item.pedidos.map((pedido) => pedido.pedido_id)),
  ).size;
  const selectedItemIds = selectedItems.flatMap((item) => item.itens_ids);
  const criticalItems = itens.filter((item) => isCriticalItem(item)).length;

  function applySelection(preset: SelectionPreset) {
    setSelectedSkus(buildSelectionMap(itens, preset));
  }

  function toggleSku(sku: string) {
    setSelectedSkus((current) => ({
      ...current,
      [sku]: !current[sku],
    }));
  }

  async function handleCopiar() {
    const rows = (selectedItems.length > 0 ? selectedItems : itens).map((item) => {
      const pedidos = item.pedidos.map((pedido) => `#${pedido.numero_pedido}`).join(", ");
      return [item.sku, item.descricao, String(item.quantidade_total), pedidos].join("\t");
    });
    const text = [
      `Fornecedor\t${fornecedor}`,
      `Empresa\t${empresaLabel}`,
      "SKU\tDescrição\tQtd\tPedidos",
      ...rows,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      toast.success("Seleção copiada em formato tabulado");
    } catch {
      toast.error("Erro ao copiar");
    }
  }

  async function handleComprar() {
    if (!empresa_id) {
      toast.error("Empresa não identificada para este fornecedor");
      return;
    }

    if (selectedItemIds.length === 0) {
      toast.error("Selecione ao menos uma linha para montar a OC");
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
          item_ids: selectedItemIds,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Erro desconhecido" }));
        throw new Error(data.error ?? "Erro ao criar OC");
      }

      const data = await res.json();
      toast.success(
        `OC confirmada: ${selectedSkuCount} SKU(s), ${data.quantidade_total ?? selectedQuantity} un`,
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
      <div className="border-b border-line bg-[linear-gradient(135deg,rgba(245,158,11,0.12),rgba(245,158,11,0.04)_52%,rgba(255,255,255,0.95))] px-4 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
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
                {empresaLabel}
              </span>
              {rascunho_ocs > 0 && (
                <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700">
                  {rascunho_ocs} rascunho{rascunho_ocs !== 1 ? "s" : ""} automático{rascunho_ocs !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Package className="h-4 w-4 text-ink-faint" />
              <h3 className="text-base font-semibold text-ink">{fornecedor}</h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-ink-muted">
              Próxima ação: <span className="font-medium text-ink">{proxima_acao}</span>
            </p>
            {rascunho_ocs > 0 && (
              <p className="mt-2 text-xs text-sky-700">
                {itens_em_rascunho} item(ns) já entraram por rascunho automático. A confirmação abaixo reaproveita esse rascunho quando fizer sentido.
              </p>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-4 xl:min-w-[560px]">
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Fila total</p>
              <p className="mt-1 text-lg font-semibold text-ink">{quantidade_total} un</p>
              <p className="text-xs text-ink-muted">{total_skus} SKU{total_skus !== 1 ? "s" : ""}</p>
            </div>
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Pedidos</p>
              <p className="mt-1 text-lg font-semibold text-ink">{pedidos_bloqueados}</p>
              <p className="text-xs text-ink-muted">travados por este fornecedor</p>
            </div>
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Linhas críticas</p>
              <p className="mt-1 text-lg font-semibold text-ink">{criticalItems}</p>
              <p className="text-xs text-ink-muted">vale separar agora</p>
            </div>
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Aging</p>
              <p className="mt-1 flex items-center gap-1 text-lg font-semibold text-ink">
                <Clock3 className="h-4 w-4 text-ink-faint" />
                {formatDaysLabel(aging_dias)}
              </p>
              <p className="text-xs text-ink-muted">item mais antigo</p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => applySelection("all")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper/90 px-3 py-2 text-xs font-medium text-ink hover:bg-paper"
          >
            Selecionar tudo
          </button>
          <button
            type="button"
            onClick={() => applySelection("critical")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper/90 px-3 py-2 text-xs font-medium text-ink hover:bg-paper"
          >
            Só críticas
          </button>
          <button
            type="button"
            onClick={() => applySelection("none")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper/90 px-3 py-2 text-xs font-medium text-ink hover:bg-paper"
          >
            Limpar seleção
          </button>
          <button
            type="button"
            onClick={handleCopiar}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper/90 px-3 py-2 text-xs font-medium text-ink hover:bg-paper"
          >
            <Copy className="h-3.5 w-3.5" />
            Copiar seleção
          </button>
          {prioridade === "critica" && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
              <AlertCircle className="h-3.5 w-3.5" />
              Priorize a rodada que destrava mais pedidos
            </span>
          )}
        </div>
      </div>

      <div className="divide-y divide-line/60">
        {itens.map((item) => {
          const isExpanded = expandedSku === item.sku;
          const checked = Boolean(selectedSkus[item.sku]);
          const hasManyPedidos = item.pedidos.length > 1;
          const critical = isCriticalItem(item);

          return (
            <div
              key={item.sku}
              className={cn(
                "px-4 py-3 transition-colors",
                checked ? "bg-surface/45" : "bg-paper",
              )}
            >
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => toggleSku(item.sku)}
                  className={cn(
                    "mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                    checked
                      ? "border-ink bg-ink text-paper"
                      : "border-line bg-paper text-transparent hover:border-ink/40",
                  )}
                  aria-label={checked ? `Remover ${item.sku} da rodada` : `Selecionar ${item.sku}`}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>

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
                    {item.em_rascunho && (
                      <span className="inline-flex items-center rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                        Em rascunho
                      </span>
                    )}
                    {critical && (
                      <span className="inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                        Prioritária
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{item.descricao}</p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    Solicitado há {formatDaysLabel(item.aging_dias)}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {item.pedidos.slice(0, isExpanded ? item.pedidos.length : 4).map((pedido) => (
                      <span
                        key={pedido.pedido_id}
                        className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                      >
                        #{pedido.numero_pedido} · {pedido.quantidade} un
                      </span>
                    ))}
                    {hasManyPedidos && (
                      <button
                        type="button"
                        onClick={() => setExpandedSku(isExpanded ? null : item.sku)}
                        className="text-[10px] font-medium text-ink-muted hover:text-ink"
                      >
                        {isExpanded ? "Ocultar pedidos" : `Ver ${item.pedidos.length - Math.min(item.pedidos.length, 4)} a mais`}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-line px-4 py-4">
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-ink">
              Rodada selecionada: {selectedSkuCount} SKU{selectedSkuCount !== 1 ? "s" : ""} · {selectedQuantity} un · {selectedPedidoCount} pedido{selectedPedidoCount !== 1 ? "s" : ""}
            </p>
            <p className="text-xs text-ink-muted">
              Use a seleção para abrir uma OC parcial quando o fornecedor ou a urgência pedirem divisões.
            </p>
          </div>
          {selectedSkuCount !== total_skus && (
            <span className="text-xs font-medium text-amber-700">
              Parte da fila ficará aguardando nova rodada
            </span>
          )}
        </div>

        {!showForm ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-muted">
              Confirme apenas o que de fato entrou nesta compra. O restante continua no planejamento do fornecedor.
            </p>
            <button
              type="button"
              onClick={() => setShowForm(true)}
              disabled={selectedSkuCount === 0}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ShoppingCart className="h-4 w-4" />
              Confirmar OC da seleção
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <textarea
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Observação da rodada: prazo, canal, condição comercial, corte de itens..."
              rows={2}
              className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none resize-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleComprar}
                disabled={submitting || selectedSkuCount === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShoppingCart className="h-4 w-4" />
                )}
                Criar OC com {selectedSkuCount} SKU{selectedSkuCount !== 1 ? "s" : ""}
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
