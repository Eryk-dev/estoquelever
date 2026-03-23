"use client";

import { useState } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Clock3,
  Loader2,
  MapPin,
  MoreVertical,
  RotateCcw,
  Truck,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { sisoFetch } from "@/lib/auth-context";
import type { CompraOcItem } from "@/types";

function shortOcId(id: string): string {
  return id.replace(/-/g, "").slice(-6).toUpperCase();
}

interface OrdemCompraCardProps {
  id: string;
  fornecedor: string;
  galpao_nome: string | null;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  recebido_em?: string | null;
  aging_dias: number;
  prioridade: "critica" | "alta" | "normal";
  pedidos_bloqueados: number;
  quantidade_total: number;
  quantidade_recebida: number;
  total_itens: number;
  itens_recebidos: number;
  proxima_acao: string;
  itens: CompraOcItem[];
  selected?: boolean;
  onToggleSelect?: () => void;
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

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  comprado: {
    label: "Comprado",
    className: "bg-amber-100 text-amber-700",
  },
  parcialmente_recebido: {
    label: "Recebimento parcial",
    className: "bg-blue-100 text-blue-700",
  },
  recebido: {
    label: "Recebido",
    className: "bg-emerald-100 text-emerald-700",
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function formatDaysLabel(days: number) {
  if (days <= 0) return "Hoje";
  if (days === 1) return "1 dia";
  return `${days} dias`;
}

function ItemActions({
  item,
  onActionComplete,
}: {
  item: CompraOcItem;
  onActionComplete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showTrocar, setShowTrocar] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"devolver" | "indisponivel" | null>(null);
  const [novoFornecedor, setNovoFornecedor] = useState("");

  const hasStockPosted = item.compra_quantidade_recebida > 0;

  async function handleDevolver() {
    setLoading(true);
    try {
      const res = await sisoFetch(`/api/compras/itens/${item.id}/devolver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Erro" }));
        throw new Error(data.error ?? "Erro ao devolver item");
      }
      toast.success("Item devolvido para fila de compras");
      onActionComplete();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao devolver item");
    } finally {
      setLoading(false);
      setOpen(false);
      setConfirmAction(null);
    }
  }

  async function handleIndisponivel() {
    setLoading(true);
    try {
      const res = await sisoFetch(`/api/compras/itens/${item.id}/indisponivel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Erro" }));
        throw new Error(data.error ?? "Erro ao marcar indisponível");
      }
      toast.success("Item marcado como indisponível");
      onActionComplete();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Erro ao marcar indisponível",
      );
    } finally {
      setLoading(false);
      setOpen(false);
      setConfirmAction(null);
    }
  }

  async function handleTrocarFornecedor() {
    if (!novoFornecedor.trim()) {
      toast.error("Informe o novo fornecedor");
      return;
    }
    setLoading(true);
    try {
      const res = await sisoFetch(
        `/api/compras/itens/${item.id}/trocar-fornecedor`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            novo_fornecedor: novoFornecedor.trim(),
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Erro" }));
        throw new Error(data.error ?? "Erro ao trocar fornecedor");
      }
      toast.success("Fornecedor alterado — item volta para fila");
      onActionComplete();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Erro ao trocar fornecedor",
      );
    } finally {
      setLoading(false);
      setOpen(false);
      setShowTrocar(false);
      setNovoFornecedor("");
    }
  }

  if (loading) {
    return (
      <div className="p-1">
        <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setShowTrocar(false);
          setNovoFornecedor("");
        }}
        className="rounded p-1 text-ink-faint hover:bg-surface hover:text-ink"
        title="Ações"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => {
              setOpen(false);
              setShowTrocar(false);
            }}
          />

          <div className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-paper shadow-lg">
            {confirmAction ? (
              <div className="space-y-2 p-3">
                <p className="text-xs font-semibold text-ink">
                  {confirmAction === "indisponivel"
                    ? "Marcar este item como indisponível?"
                    : hasStockPosted
                      ? `Devolver item com ${item.compra_quantidade_recebida} un já lançadas no estoque?`
                      : "Devolver item para a fila de compras?"}
                </p>
                {confirmAction === "devolver" && hasStockPosted && (
                  <p className="text-[11px] text-red-600">
                    O estoque já lançado no Tiny não será revertido automaticamente.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={confirmAction === "indisponivel" ? handleIndisponivel : handleDevolver}
                    className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAction(null)}
                    className="text-xs text-ink-muted hover:text-ink"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : !showTrocar ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmAction("devolver")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface"
                >
                  <RotateCcw className="h-3.5 w-3.5 text-ink-muted" />
                  Devolver pra fila
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmAction("indisponivel")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface"
                >
                  <XCircle className="h-3.5 w-3.5 text-ink-muted" />
                  Marcar indisponível
                </button>
                <button
                  type="button"
                  onClick={() => setShowTrocar(true)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface"
                >
                  <ArrowRightLeft className="h-3.5 w-3.5 text-ink-muted" />
                  Trocar fornecedor
                </button>
              </>
            ) : (
              <div className="space-y-2 p-3">
                <p className="text-xs font-medium text-ink">Novo fornecedor</p>
                <input
                  type="text"
                  value={novoFornecedor}
                  onChange={(e) => setNovoFornecedor(e.target.value)}
                  placeholder="Nome do fornecedor..."
                  className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleTrocarFornecedor();
                  }}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTrocarFornecedor}
                    className="rounded-md bg-ink px-3 py-1 text-xs font-medium text-paper hover:bg-ink/90"
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowTrocar(false);
                      setNovoFornecedor("");
                    }}
                    className="text-xs text-ink-muted hover:text-ink"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function OrdemCompraCard({
  id,
  fornecedor,
  galpao_nome,
  status,
  observacao,
  comprado_por_nome,
  comprado_em,
  recebido_em,
  aging_dias,
  prioridade,
  pedidos_bloqueados,
  quantidade_total,
  quantidade_recebida,
  total_itens,
  itens_recebidos,
  proxima_acao,
  itens,
  selected = false,
  onToggleSelect,
}: OrdemCompraCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const selectionEnabled = typeof onToggleSelect === "function";
  const isCompleted = status === "recebido";

  const progresso = quantidade_total > 0
    ? Math.min((quantidade_recebida / quantidade_total) * 100, 100)
    : 0;
  const prioridadeMeta = PRIORIDADE_META[prioridade];
  const statusBadge = STATUS_BADGE[status] ?? STATUS_BADGE.comprado;

  function handleActionComplete() {
    queryClient.invalidateQueries({ queryKey: ["compras"] });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-paper">
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          {selectionEnabled && (
            <label className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center">
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelect?.()}
                className="h-4 w-4 rounded border-line text-ink focus:ring-ink/20"
                aria-label={`Selecionar OC ${fornecedor}`}
              />
            </label>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink">
                    {fornecedor}
                  </h3>
                  <span className="text-xs font-mono text-ink-faint">#{shortOcId(id)}</span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      statusBadge.className,
                    )}
                  >
                    {statusBadge.label}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                      prioridadeMeta.className,
                    )}
                  >
                    {prioridadeMeta.label}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                    <MapPin className="h-3 w-3" />
                    {galpao_nome ?? "—"}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-ink-muted sm:text-right">
                <div>
                  <span className="font-semibold text-ink">{quantidade_recebida}/{quantidade_total}</span> un
                </div>
                <div>
                  <span className="font-semibold text-ink">{pedidos_bloqueados}</span> pedido{pedidos_bloqueados !== 1 ? "s" : ""}
                </div>
                <div className="flex items-center gap-1">
                  <Clock3 className="h-3 w-3" />
                  {formatDaysLabel(aging_dias)}
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  progresso >= 100 ? "bg-emerald-500" : "bg-blue-500",
                )}
                style={{ width: `${progresso}%` }}
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-faint">
              <span>{proxima_acao}</span>
              <span>·</span>
              {comprado_por_nome && <span>{comprado_por_nome}</span>}
              <span>{formatDate(comprado_em)}</span>
              {isCompleted && recebido_em && (
                <>
                  <span>·</span>
                  <span>Recebida {formatDate(recebido_em)}</span>
                </>
              )}
              <span>·</span>
              <span>{itens_recebidos}/{total_itens} itens</span>
            </div>
          </div>
        </div>
      </div>

      {observacao && (
        <div className="border-b border-line/60 px-4 py-3">
          <p className="text-xs italic text-ink-muted">{observacao}</p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between border-t border-line/60 px-4 py-2 text-xs font-medium text-ink-muted hover:bg-surface/30 transition-colors"
      >
        <span>{total_itens} ite{total_itens !== 1 ? "ns" : "m"}</span>
        <span className="inline-flex items-center gap-1">
          {expanded ? "Ocultar" : "Ver"}
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>

      {expanded && (
        <div className="divide-y divide-line/60">
          {itens.map((item) => {
            const restante = Math.max(item.quantidade - item.compra_quantidade_recebida, 0);
            return (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 gap-3">
                  {item.imagem ? (
                    <img
                      src={item.imagem}
                      alt={item.sku}
                      className="h-11 w-11 shrink-0 rounded-lg border border-line bg-surface object-cover"
                    />
                  ) : (
                    <div className="h-11 w-11 shrink-0 rounded-lg border border-dashed border-line bg-surface" />
                  )}

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-ink">{item.sku}</p>
                      <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                        #{item.numero_pedido}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-muted">{item.descricao}</p>
                    <p className="mt-1 text-[11px] text-ink-faint">
                      Solicitado há {formatDaysLabel(item.aging_dias)}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-ink">
                      {item.compra_quantidade_recebida}/{item.quantidade} un
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      {restante > 0 ? `${restante} un pendente` : "item fechado"}
                    </p>
                  </div>
                  {!isCompleted && (
                    <ItemActions
                      item={item}
                      onActionComplete={handleActionComplete}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-line px-4 py-2.5">
        {isCompleted ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <ClipboardCheck className="h-3.5 w-3.5" />
            Concluída
          </span>
        ) : (
          <button
            type="button"
            onClick={() => router.push(`/compras/conferencia/${id}?ocs=${id}`)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-paper hover:bg-ink/90"
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            Conferir recebimento
          </button>
        )}
      </div>
    </div>
  );
}
