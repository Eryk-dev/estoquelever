import { ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getDecisaoColors,
  getDecisaoStripColor,
  getEcommerceAbbr,
  getEcommerceColors,
  getFilialColors,
  formatTime,
  DECISAO_LABELS,
} from "@/lib/domain-helpers";
import type { Decisao, Pedido } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface PedidoCardConcluidoProps {
  pedido: Pedido;
}

export function PedidoCardConcluido({ pedido }: PedidoCardConcluidoProps) {
  const decisao: Decisao = pedido.decisaoFinal ?? pedido.sugestao;
  const ecommerceAbbr = getEcommerceAbbr(pedido.nomeEcommerce);
  const ecommerceColors = getEcommerceColors(pedido.nomeEcommerce);
  const decisaoColors = getDecisaoColors(decisao);
  const stripColor = getDecisaoStripColor(decisao);
  const time = formatTime(pedido.processadoEm);
  const isAuto = pedido.tipoResolucao === "auto";

  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-lg border bg-paper opacity-75",
        "border-line",
        "transition-opacity hover:opacity-100",
      )}
      aria-label={`Pedido concluído #${pedido.numero}`}
    >
      {/* Thin color strip */}
      <div className={cn("w-1 shrink-0", stripColor)} aria-hidden="true" />

      {/* Single content row */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
        {/* Order number */}
        <span className="shrink-0 font-mono text-sm font-bold text-ink">
          #{pedido.numero}
        </span>

        {/* Client name */}
        <span
          className="min-w-0 max-w-[180px] truncate text-sm text-ink-muted"
          title={pedido.cliente.nome}
        >
          {pedido.cliente.nome}
        </span>

        {/* E-commerce */}
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold",
            ecommerceColors,
          )}
        >
          {ecommerceAbbr}
        </span>

        {/* Filial */}
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold",
            getFilialColors(pedido.filialOrigem),
          )}
        >
          {pedido.filialOrigem}
        </span>

        {/* Arrow */}
        <ArrowRight className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden="true" />

        {/* Decision */}
        <span className={cn("shrink-0 text-sm font-semibold", decisaoColors)}>
          {DECISAO_LABELS[decisao]}
        </span>

        {/* Checkmark */}
        <Check
          className="h-3.5 w-3.5 shrink-0 text-ink-faint"
          strokeWidth={2.5}
          aria-label="Concluído"
        />

        {/* Resolution type */}
        <span
          className={cn(
            "shrink-0 text-xs",
            isAuto
              ? "text-blue-600 dark:text-blue-400"
              : "text-ink-faint",
          )}
        >
          {isAuto ? "Auto" : `Manual${pedido.operador ? ` (${pedido.operador})` : ""}`}
        </span>

        {/* Timestamp — pushed to the right */}
        {time && (
          <span className="ml-auto shrink-0 font-mono text-xs text-ink-faint">
            {time}
          </span>
        )}
      </div>
    </div>
  );
}
