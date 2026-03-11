"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CheckCircle2, Truck, Calendar, History } from "lucide-react";
import { PedidoTimeline } from "./pedido-timeline";
import type { StatusSeparacao } from "@/types";

export interface SeparacaoPedido {
  id: string;
  numero_nf: string;
  numero_ec: string | null;
  numero_pedido: string;
  cliente: string | null;
  uf: string | null;
  cidade: string | null;
  forma_envio: string | null;
  data_pedido: string;
  empresa_origem_nome: string | null;
  status_separacao: StatusSeparacao;
  marcadores: string[];
  total_itens: number;
  itens_marcados: number;
  itens_bipados: number;
  galpao_id: string | null;
}

interface SeparacaoCardProps {
  pedido: SeparacaoPedido;
  checkbox?: boolean;
  checked?: boolean;
  onToggle?: (id: string) => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function SeparacaoCard({
  pedido,
  checkbox,
  checked,
  onToggle,
}: SeparacaoCardProps) {
  const [timelineOpen, setTimelineOpen] = useState(false);
  const isEmbalado = pedido.status_separacao === "embalado";
  const isEmSeparacao = pedido.status_separacao === "em_separacao";

  // Separation progress (for em_separacao)
  const progressPct =
    isEmSeparacao && pedido.total_itens > 0
      ? (pedido.itens_marcados / pedido.total_itens) * 100
      : 0;

  return (
    <article
      className={cn(
        "overflow-hidden rounded-xl border bg-paper shadow-sm transition-colors",
        isEmbalado
          ? "border-emerald-200 dark:border-emerald-800"
          : "border-line",
        checkbox && checked && "ring-2 ring-zinc-900/10 dark:ring-zinc-100/10",
      )}
      aria-label={`Pedido #${pedido.numero_pedido}`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Checkbox */}
        {checkbox && (
          <label className="flex shrink-0 cursor-pointer items-center pt-0.5">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle?.(pedido.id)}
              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </label>
        )}

        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* Row 1: Order number + client + timeline toggle */}
          <div className="flex items-center gap-2">
            {isEmbalado && (
              <CheckCircle2
                className="h-4 w-4 shrink-0 text-emerald-500"
                aria-label="Embalado"
              />
            )}
            <span className="shrink-0 font-mono text-sm font-bold text-ink">
              #{pedido.numero_pedido}
            </span>
            <span className="h-3 w-px bg-line" aria-hidden="true" />
            <span
              className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300"
              title={pedido.cliente ?? ""}
            >
              {pedido.cliente ?? "—"}
            </span>

            {/* Timeline toggle */}
            <button
              type="button"
              onClick={() => setTimelineOpen((v) => !v)}
              className={cn(
                "shrink-0 rounded p-1 transition-colors",
                timelineOpen
                  ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300",
              )}
              title="Ver histórico"
              aria-label="Ver histórico do pedido"
              aria-expanded={timelineOpen}
            >
              <History className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Row 2: Metadata badges */}
          <div className="flex flex-wrap items-center gap-2">
            {pedido.empresa_origem_nome && (
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                {pedido.empresa_origem_nome}
              </span>
            )}

            {pedido.numero_ec && (
              <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                EC {pedido.numero_ec}
              </span>
            )}

            {pedido.forma_envio && (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
                <Truck className="h-3 w-3" aria-hidden="true" />
                {pedido.forma_envio}
              </span>
            )}

            {pedido.uf && (
              <span className="shrink-0 text-[11px] font-medium text-ink-faint">
                {pedido.cidade ? `${pedido.cidade}/${pedido.uf}` : pedido.uf}
              </span>
            )}

            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
              <Calendar className="h-3 w-3" aria-hidden="true" />
              {formatDate(pedido.data_pedido)}
            </span>
          </div>

          {/* Em Separacao: progress bar */}
          {isEmSeparacao && pedido.total_itens > 0 && (
            <div className="mt-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-zinc-600 dark:text-zinc-300">
                  {pedido.itens_marcados}/{pedido.total_itens} itens separados
                </span>
                <span className="font-mono text-zinc-400 tabular-nums">
                  {Math.round(progressPct)}%
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    progressPct >= 100
                      ? "bg-emerald-500"
                      : progressPct > 0
                        ? "bg-blue-500"
                        : "bg-zinc-300 dark:bg-zinc-600",
                  )}
                  style={{ width: `${Math.min(progressPct, 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Marcadores */}
          {pedido.marcadores.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              {pedido.marcadores.map((m) => (
                <span
                  key={m}
                  className="rounded bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-500"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Timeline (expandable) */}
      {timelineOpen && (
        <>
          <div className="mx-4 h-px bg-line" />
          <PedidoTimeline pedidoId={pedido.id} open={timelineOpen} />
        </>
      )}
    </article>
  );
}
