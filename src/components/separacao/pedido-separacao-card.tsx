"use client";

import { cn } from "@/lib/utils";
import {
  getEcommerceAbbr,
  getEcommerceColors,
  DECISAO_LABELS,
  getDecisaoColors,
} from "@/lib/domain-helpers";
import { ItemSeparacaoRow, type SeparacaoItem } from "./item-separacao-row";
import type { Decisao } from "@/types";

export interface PedidoSeparacao {
  id: string;
  numero: string;
  data: string;
  cliente_nome: string;
  nome_ecommerce: string;
  forma_envio_descricao: string;
  status_separacao: string;
  decisao?: Decisao | null;
  separado_por?: string | null;
  embalado_em?: string | null;
  etiqueta_status?: string | null;
  itens: SeparacaoItem[];
}

interface PedidoSeparacaoCardProps {
  pedido: PedidoSeparacao;
}

export function PedidoSeparacaoCard({ pedido }: PedidoSeparacaoCardProps) {
  const totalItens = pedido.itens.reduce((sum, i) => sum + i.quantidade_pedida, 0);
  const totalBipados = pedido.itens.reduce((sum, i) => sum + i.quantidade_bipada, 0);
  const progressPct = totalItens > 0 ? (totalBipados / totalItens) * 100 : 0;
  const allDone = totalBipados === totalItens && totalItens > 0;

  const ecommerceAbbr = getEcommerceAbbr(pedido.nome_ecommerce);
  const ecommerceColors = getEcommerceColors(pedido.nome_ecommerce);

  return (
    <article
      className={cn(
        "overflow-hidden rounded-xl border bg-paper shadow-sm",
        "border-line",
        allDone ? "border-emerald-200 dark:border-emerald-800" : "",
      )}
      aria-label={`Pedido #${pedido.numero}`}
    >
      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="shrink-0 font-mono text-sm font-bold text-ink">
          #{pedido.numero}
        </span>

        <span className="h-3 w-px bg-line" aria-hidden="true" />

        <span
          className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300"
          title={pedido.cliente_nome}
        >
          {pedido.cliente_nome}
        </span>

        {/* Ecommerce badge */}
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide",
            ecommerceColors,
          )}
          title={pedido.nome_ecommerce}
        >
          {ecommerceAbbr}
        </span>

        {/* Shipping method */}
        {pedido.forma_envio_descricao && (
          <span className="shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400">
            {pedido.forma_envio_descricao}
          </span>
        )}

        {/* Decisao badge */}
        {pedido.decisao && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold",
              getDecisaoColors(pedido.decisao),
            )}
          >
            {DECISAO_LABELS[pedido.decisao]}
          </span>
        )}
      </header>

      {/* Progress bar */}
      <div className="px-4 pb-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">
            {totalBipados}/{totalItens} itens bipados
          </span>
          <span className="font-mono text-zinc-400 tabular-nums">
            {Math.round(progressPct)}%
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              allDone
                ? "bg-emerald-500"
                : progressPct > 0
                  ? "bg-blue-500"
                  : "bg-zinc-300 dark:bg-zinc-600",
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Divider */}
      <div className="mx-4 h-px bg-line" />

      {/* Items list */}
      <div className="divide-y divide-line px-4">
        {pedido.itens.map((item) => (
          <ItemSeparacaoRow key={item.produto_id} item={item} />
        ))}
      </div>
    </article>
  );
}
