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

interface OcItem {
  id: string;
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade: number;
  compra_status: string | null;
  compra_quantidade_recebida: number;
  pedido_id: string;
  numero_pedido: string;
  aging_dias: number;
}

interface OrdemCompraCardProps {
  id: string;
  index: number;
  fornecedor: string;
  galpao_nome: string | null;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  aging_dias: number;
  prioridade: "critica" | "alta" | "normal";
  pedidos_bloqueados: number;
  quantidade_total: number;
  quantidade_recebida: number;
  total_itens: number;
  itens_recebidos: number;
  proxima_acao: string;
  itens: OcItem[];
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
  cargo,
  onActionComplete,
}: {
  item: OcItem;
  cargo: string;
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
        body: JSON.stringify({ cargo }),
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
        body: JSON.stringify({ cargo }),
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
            cargo,
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

          <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-line bg-paper shadow-lg">
            {!showTrocar ? (
              <>
                <button
                  type="button"
                  onClick={handleDevolver}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface"
                >
                  <RotateCcw className="h-3.5 w-3.5 text-ink-muted" />
                  Devolver pra fila
                </button>
                <button
                  type="button"
                  onClick={handleIndisponivel}
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
  index,
  fornecedor,
  galpao_nome,
  status,
  observacao,
  comprado_por_nome,
  comprado_em,
  aging_dias,
  prioridade,
  pedidos_bloqueados,
  quantidade_total,
  quantidade_recebida,
  total_itens,
  itens_recebidos,
  proxima_acao,
  itens,
  cargo,
}: OrdemCompraCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const progresso = quantidade_total > 0
    ? Math.min((quantidade_recebida / quantidade_total) * 100, 100)
    : 0;
  const prioridadeMeta = PRIORIDADE_META[prioridade];
  const statusBadge = STATUS_BADGE[status] ?? STATUS_BADGE.comprado;

  function handleActionComplete() {
    queryClient.invalidateQueries({ queryKey: ["compras"] });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-paper">
      <div className="border-b border-line bg-[linear-gradient(135deg,rgba(59,130,246,0.10),rgba(59,130,246,0.03)_55%,rgba(255,255,255,0.92))] px-4 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold",
                  statusBadge.className,
                )}
              >
                {statusBadge.label}
              </span>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                  prioridadeMeta.className,
                )}
              >
                {prioridadeMeta.label}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-paper/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted">
                <MapPin className="h-3.5 w-3.5" />
                {galpao_nome ?? "Galpão não definido"}
              </span>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Truck className="h-4 w-4 text-ink-faint" />
              <h3 className="text-base font-semibold text-ink">
                OC #{index} · {fornecedor}
              </h3>
            </div>

            <p className="mt-2 text-sm text-ink-muted">
              Próxima ação: <span className="font-medium text-ink">{proxima_acao}</span>
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
              {comprado_por_nome && (
                <span>
                  Comprado por <span className="font-medium text-ink">{comprado_por_nome}</span>
                </span>
              )}
              <span>Data da compra: {formatDate(comprado_em)}</span>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[420px]">
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Recebido</p>
              <p className="mt-1 text-lg font-semibold text-ink">
                {quantidade_recebida}/{quantidade_total} un
              </p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface">
                <div
                  className="h-full rounded-full bg-blue-500"
                  style={{ width: `${progresso}%` }}
                />
              </div>
            </div>
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Pedidos</p>
              <p className="mt-1 text-lg font-semibold text-ink">{pedidos_bloqueados}</p>
              <p className="text-xs text-ink-muted">ainda aguardando esta OC</p>
            </div>
            <div className="rounded-xl border border-line bg-paper/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Aging</p>
              <p className="mt-1 flex items-center gap-1 text-lg font-semibold text-ink">
                <Clock3 className="h-4 w-4 text-ink-faint" />
                {formatDaysLabel(aging_dias)}
              </p>
              <p className="text-xs text-ink-muted">{itens_recebidos}/{total_itens} itens fechados</p>
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
        className="flex w-full items-center justify-between border-b border-line/60 px-4 py-2.5 text-xs font-medium text-ink-muted hover:bg-surface/30 transition-colors"
      >
        <span>{total_itens} ite{total_itens !== 1 ? "ns" : "m"}</span>
        <span className="inline-flex items-center gap-1">
          {expanded ? "Ocultar" : "Ver itens"}
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
                  <ItemActions
                    item={item}
                    cargo={cargo}
                    onActionComplete={handleActionComplete}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-line px-4 py-4">
        <button
          type="button"
          onClick={() => router.push(`/compras/conferencia/${id}`)}
          className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink/90"
        >
          <ClipboardCheck className="h-4 w-4" />
          Conferir recebimento
        </button>
      </div>
    </div>
  );
}
