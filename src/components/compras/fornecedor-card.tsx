"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  Loader2,
  MapPin,
  Package,
  ShoppingCart,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import type { CompraItemAgrupado } from "@/types";

interface EmpresaBadge {
  id: string;
  nome: string;
}

interface GalpaoOption {
  id: string;
  nome: string;
}

interface FornecedorCardProps {
  fornecedor: string;
  galpao_sugerido_id: string | null;
  galpao_sugerido_nome: string | null;
  empresas: EmpresaBadge[];
  galpoes: GalpaoOption[];
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
  galpao_sugerido_id,
  galpao_sugerido_nome,
  empresas,
  galpoes,
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
  const [observacao, setObservacao] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [selectedGalpaoId, setSelectedGalpaoId] = useState<string>(
    galpao_sugerido_id ?? galpoes[0]?.id ?? "",
  );
  const [selectedSkus, setSelectedSkus] = useState<Record<string, boolean>>(() =>
    buildSelectionMap(itens, "all"),
  );

  // Sync selectedGalpaoId when galpoes load async (initially empty)
  useEffect(() => {
    if (!selectedGalpaoId && galpoes.length > 0) {
      setSelectedGalpaoId(galpao_sugerido_id ?? galpoes[0]?.id ?? "");
    }
  }, [galpoes, galpao_sugerido_id, selectedGalpaoId]);

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
  const selectedGalpaoNome = galpoes.find((g) => g.id === selectedGalpaoId)?.nome ?? galpao_sugerido_nome ?? "?";

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
      `Galpão recebimento\t${selectedGalpaoNome}`,
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
    if (!selectedGalpaoId) {
      toast.error("Selecione o galpão de recebimento");
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
          galpao_id: selectedGalpaoId,
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
        `OC confirmada: ${selectedSkuCount} SKU(s), ${data.quantidade_total ?? selectedQuantity} un → ${selectedGalpaoNome}`,
      );
      setObservacao("");
      setExpanded(false);
      queryClient.invalidateQueries({ queryKey: ["compras"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar OC");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-paper">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="w-full px-4 py-4 text-left transition-colors hover:bg-surface/30"
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
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
              {galpao_sugerido_nome && (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
                  <MapPin className="h-3.5 w-3.5" />
                  {galpao_sugerido_nome}
                </span>
              )}
              {empresas.map((emp) => (
                <span
                  key={emp.id}
                  className="inline-flex items-center rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted"
                >
                  {emp.nome}
                </span>
              ))}
              {rascunho_ocs > 0 && (
                <span className="inline-flex items-center rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700">
                  {rascunho_ocs} rascunho{rascunho_ocs !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            <div className="mt-2 flex items-center gap-2">
              <Package className="h-4 w-4 text-ink-faint" />
              <h3 className="text-base font-semibold text-ink">{fornecedor}</h3>
            </div>
            <p className="mt-1 text-xs text-ink-muted">{proxima_acao}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-ink">
              {quantidade_total} un
            </span>
            <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-ink">
              {pedidos_bloqueados} pedido{pedidos_bloqueados !== 1 ? "s" : ""}
            </span>
            <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-ink">
              {total_skus} SKU{total_skus !== 1 ? "s" : ""}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-xs font-medium text-ink">
              <Clock3 className="h-3.5 w-3.5 text-ink-faint" />
              {formatDaysLabel(aging_dias)}
            </span>
            <span className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink">
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {expanded ? "Fechar" : "Revisar rodada"}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <>
          <div className="border-t border-line bg-surface/30 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => applySelection("all")}
                className="rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface"
              >
                Tudo
              </button>
              <button
                type="button"
                onClick={() => applySelection("critical")}
                className="rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface"
              >
                Críticas
              </button>
              <button
                type="button"
                onClick={() => applySelection("none")}
                className="rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface"
              >
                Limpar
              </button>
              <button
                type="button"
                onClick={handleCopiar}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface"
              >
                <Copy className="h-3.5 w-3.5" />
                Copiar
              </button>
              {prioridade === "critica" && (
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Priorize este fornecedor
                </span>
              )}
              {criticalItems > 0 && (
                <span className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700">
                  {criticalItems} linha{criticalItems !== 1 ? "s" : ""} crítica{criticalItems !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            {rascunho_ocs > 0 && (
              <p className="mt-2 text-xs text-sky-700">
                {itens_em_rascunho} item(ns) já vieram de rascunho automático.
              </p>
            )}
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
                    checked ? "bg-paper" : "bg-zinc-50/60",
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
                        className="h-10 w-10 shrink-0 rounded-lg border border-line bg-surface object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-dashed border-line bg-surface text-ink-faint">
                        <Package className="h-4 w-4" />
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-ink">{item.sku}</p>
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                          {item.quantidade_total} un
                        </span>
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                          {item.pedidos_bloqueados} pedido{item.pedidos_bloqueados !== 1 ? "s" : ""}
                        </span>
                        {item.em_rascunho && (
                          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                            Rascunho
                          </span>
                        )}
                        {critical && (
                          <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                            Prioritária
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">{item.descricao}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                        <span>Solicitado há {formatDaysLabel(item.aging_dias)}</span>
                        {hasManyPedidos && (
                          <button
                            type="button"
                            onClick={() => setExpandedSku(isExpanded ? null : item.sku)}
                            className="font-medium text-ink-muted hover:text-ink"
                          >
                            {isExpanded ? "Ocultar pedidos" : `Ver ${item.pedidos.length} pedidos`}
                          </button>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.pedidos.slice(0, isExpanded ? item.pedidos.length : 3).map((pedido) => (
                          <span
                            key={pedido.pedido_id}
                            className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                          >
                            #{pedido.numero_pedido} · {pedido.quantidade} un
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t border-line px-4 py-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-medium text-ink">
                  Selecionados: {selectedSkuCount} SKU{selectedSkuCount !== 1 ? "s" : ""} · {selectedQuantity} un · {selectedPedidoCount} pedido{selectedPedidoCount !== 1 ? "s" : ""}
                </p>
                {selectedSkuCount !== total_skus && (
                  <span className="text-xs text-amber-700">
                    O restante continua aguardando nova rodada
                  </span>
                )}
              </div>

              {/* Galpão picker */}
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm font-medium text-ink">
                  <MapPin className="h-4 w-4 text-ink-faint" />
                  Receber em:
                </label>
                <select
                  value={selectedGalpaoId}
                  onChange={(e) => setSelectedGalpaoId(e.target.value)}
                  className="flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink focus:border-ink focus:outline-none"
                >
                  {galpoes.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.nome}{g.id === galpao_sugerido_id ? " (sugerido)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              <input
                value={observacao}
                onChange={(e) => setObservacao(e.target.value)}
                placeholder="Observação opcional da rodada"
                className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
              />

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-ink-muted">
                  Confirme só o que entrou nesta compra.
                </p>
                <button
                  type="button"
                  onClick={handleComprar}
                  disabled={submitting || selectedSkuCount === 0 || !selectedGalpaoId}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShoppingCart className="h-4 w-4" />
                  )}
                  Confirmar OC → {selectedGalpaoNome}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
