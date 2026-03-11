"use client";

import { useState } from "react";
import {
  Truck,
  ClipboardCheck,
  MoreVertical,
  RotateCcw,
  XCircle,
  ArrowRightLeft,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface OcItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade: number;
  compra_status: string | null;
  compra_quantidade_recebida: number;
  pedido_id: string;
  numero_pedido: string;
}

interface OrdemCompraCardProps {
  id: string;
  index: number;
  fornecedor: string;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  total_itens: number;
  itens_recebidos: number;
  itens: OcItem[];
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function daysAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Hoje";
  if (days === 1) return "Há 1 dia";
  return `Há ${days} dias`;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  comprado: {
    label: "Comprado",
    className: "bg-amber-100 text-amber-700",
  },
  parcialmente_recebido: {
    label: "Parcial",
    className: "bg-blue-100 text-blue-700",
  },
  recebido: {
    label: "Recebido",
    className: "bg-emerald-100 text-emerald-700",
  },
};

function ItemActions({
  item,
  onActionComplete,
}: {
  item: OcItem;
  onActionComplete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showTrocar, setShowTrocar] = useState(false);
  const [novoFornecedor, setNovoFornecedor] = useState("");

  async function handleDevolver() {
    setLoading(true);
    try {
      const res = await fetch(`/api/compras/itens/${item.id}/devolver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cargo: "admin" }),
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
    }
  }

  async function handleIndisponivel() {
    if (!confirm("Marcar este item como indisponível?")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/compras/itens/${item.id}/indisponivel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cargo: "admin" }),
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
    }
  }

  async function handleTrocarFornecedor() {
    if (!novoFornecedor.trim()) {
      toast.error("Informe o novo fornecedor");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/compras/itens/${item.id}/trocar-fornecedor`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            novo_fornecedor: novoFornecedor.trim(),
            cargo: "admin",
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
        className="rounded p-1 text-ink-faint hover:bg-surface hover:text-ink transition-colors"
        title="Ações"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open && (
        <>
          {/* Backdrop to close on outside click */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => {
              setOpen(false);
              setShowTrocar(false);
            }}
          />

          <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-line bg-paper shadow-lg overflow-hidden">
            {!showTrocar ? (
              <>
                <button
                  type="button"
                  onClick={handleDevolver}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5 text-ink-muted" />
                  Devolver pra fila
                </button>
                <button
                  type="button"
                  onClick={handleIndisponivel}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface transition-colors"
                >
                  <XCircle className="h-3.5 w-3.5 text-ink-muted" />
                  Marcar indisponível
                </button>
                <button
                  type="button"
                  onClick={() => setShowTrocar(true)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface transition-colors"
                >
                  <ArrowRightLeft className="h-3.5 w-3.5 text-ink-muted" />
                  Trocar fornecedor
                </button>
              </>
            ) : (
              <div className="p-3 space-y-2">
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
                    className="rounded-md bg-ink px-3 py-1 text-xs font-medium text-paper hover:bg-ink/90 transition-colors"
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowTrocar(false);
                      setNovoFornecedor("");
                    }}
                    className="text-xs text-ink-muted hover:text-ink transition-colors"
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
  index,
  fornecedor,
  status,
  observacao,
  comprado_por_nome,
  comprado_em,
  total_itens,
  itens_recebidos,
  itens,
}: OrdemCompraCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isParcial = status === "parcialmente_recebido";

  function handleActionComplete() {
    queryClient.invalidateQueries({ queryKey: ["compras"] });
  }

  return (
    <div className="rounded-xl border border-line bg-paper overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-surface/50">
        <div className="flex items-center gap-2 min-w-0">
          <Truck className="h-4 w-4 text-ink-faint shrink-0" />
          <h3 className="text-sm font-semibold text-ink truncate">
            OC #{index} — {fornecedor}
          </h3>
          {isParcial && (
            <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
              {itens_recebidos}/{total_itens} recebidos
            </span>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted border-b border-line/50">
        {comprado_por_nome && (
          <span>
            Comprado por <span className="font-medium text-ink">{comprado_por_nome}</span> em{" "}
            {formatDate(comprado_em)}
          </span>
        )}
        {comprado_em && (
          <span className="text-ink-faint">{daysAgo(comprado_em)}</span>
        )}
      </div>

      {/* Observacao */}
      {observacao && (
        <div className="px-4 py-2 border-b border-line/50">
          <p className="text-xs text-ink-muted italic">{observacao}</p>
        </div>
      )}

      {/* Items */}
      <div className="divide-y divide-line/50">
        {itens.map((item) => {
          const badge = STATUS_BADGE[item.compra_status ?? ""] ?? null;
          return (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
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
                  {item.quantidade}un
                </span>
                <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                  #{item.numero_pedido}
                </span>
                {badge && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                      badge.className,
                    )}
                  >
                    {badge.label}
                  </span>
                )}
                <ItemActions
                  item={item}
                  onActionComplete={handleActionComplete}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-line px-4 py-3">
        <button
          type="button"
          onClick={() => router.push(`/compras/conferencia/${id}`)}
          className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-ink/90"
        >
          <ClipboardCheck className="h-4 w-4" />
          Conferir Recebimento
        </button>
      </div>
    </div>
  );
}
