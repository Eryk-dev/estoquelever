import { ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Decisao, Pedido } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DECISAO_LABEL: Record<Decisao, string> = {
  propria: "Própria",
  transferencia: "Transferência",
  oc: "Ordem de Compra",
};

function getDecisaoColors(decisao: Decisao): string {
  if (decisao === "propria") return "text-emerald-700 dark:text-emerald-400";
  if (decisao === "transferencia") return "text-blue-700 dark:text-blue-400";
  return "text-amber-700 dark:text-amber-400";
}

function getDecisaoStripColor(decisao: Decisao): string {
  if (decisao === "propria") return "bg-emerald-500";
  if (decisao === "transferencia") return "bg-blue-500";
  return "bg-amber-500";
}

function getEcommerceAbbr(nome: string): string {
  if (nome.toLowerCase().includes("mercado livre")) return "ML";
  if (nome.toLowerCase().includes("shopee")) return "SH";
  if (nome.toLowerCase().includes("amazon")) return "AZ";
  if (nome.toLowerCase().includes("magalu")) return "MG";
  return nome.slice(0, 2).toUpperCase();
}

function getEcommerceColors(nome: string): string {
  if (nome.toLowerCase().includes("mercado livre"))
    return "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/60 dark:text-yellow-300";
  if (nome.toLowerCase().includes("shopee"))
    return "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300";
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
}

/** Format ISO timestamp to HH:MM */
function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface PedidoCardConcluidoProps {
  pedido: Pedido;
}

export function PedidoCardConcluido({ pedido }: PedidoCardConcluidoProps) {
  const decisao = pedido.decisaoFinal ?? pedido.sugestao;
  const ecommerceAbbr = getEcommerceAbbr(pedido.nomeEcommerce);
  const ecommerceColors = getEcommerceColors(pedido.nomeEcommerce);
  const decisaoColors = getDecisaoColors(decisao);
  const stripColor = getDecisaoStripColor(decisao);
  const time = formatTime(pedido.processadoEm);
  const isAuto = pedido.tipoResolucao === "auto";

  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-lg border bg-white opacity-75",
        "border-zinc-200 dark:border-zinc-700/60 dark:bg-zinc-900",
        "transition-opacity hover:opacity-100",
      )}
      aria-label={`Pedido concluído #${pedido.numero}`}
    >
      {/* Thin color strip */}
      <div className={cn("w-1 shrink-0", stripColor)} aria-hidden="true" />

      {/* Single content row */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
        {/* Order number */}
        <span className="shrink-0 font-mono text-sm font-bold text-zinc-700 dark:text-zinc-200">
          #{pedido.numero}
        </span>

        {/* Client name */}
        <span
          className="min-w-0 max-w-[180px] truncate text-sm text-zinc-500 dark:text-zinc-400"
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
            pedido.filialOrigem === "CWB"
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
              : "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
          )}
        >
          {pedido.filialOrigem}
        </span>

        {/* Arrow */}
        <ArrowRight className="h-3 w-3 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />

        {/* Decision */}
        <span className={cn("shrink-0 text-sm font-semibold", decisaoColors)}>
          {DECISAO_LABEL[decisao]}
        </span>

        {/* Checkmark */}
        <Check
          className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500"
          strokeWidth={2.5}
          aria-label="Concluído"
        />

        {/* Resolution type */}
        <span
          className={cn(
            "shrink-0 text-xs",
            isAuto
              ? "text-blue-600 dark:text-blue-400"
              : "text-zinc-400 dark:text-zinc-500",
          )}
        >
          {isAuto ? "Auto" : `Manual${pedido.operador ? ` (${pedido.operador})` : ""}`}
        </span>

        {/* Timestamp — pushed to the right */}
        {time && (
          <span className="ml-auto shrink-0 font-mono text-xs text-zinc-300 dark:text-zinc-600">
            {time}
          </span>
        )}
      </div>
    </div>
  );
}
