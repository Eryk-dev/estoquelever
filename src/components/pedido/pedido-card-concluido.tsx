"use client";

import { useState } from "react";
import { ArrowRight, Check, ChevronDown, MapPin, Package, ShoppingCart } from "lucide-react";
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
import type { Decisao, EstoqueItem, Pedido } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Read-only stock pill
// ─────────────────────────────────────────────────────────────────────────────

function StockPill({
  label,
  disponivel,
  quantidadePedida,
  isRelevant,
}: {
  label: string;
  disponivel: number | null;
  quantidadePedida: number;
  isRelevant?: boolean;
}) {
  const isNull = disponivel == null;
  const isZero = !isNull && disponivel === 0;
  const isSufficient = !isNull && disponivel >= quantidadePedida;

  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums">
      <span
        className={cn(
          "text-[10px] font-medium uppercase tracking-wide",
          isRelevant ? "text-zinc-600 dark:text-zinc-300" : "text-ink-faint",
        )}
      >
        {label}
      </span>
      {isNull ? (
        <span className="font-semibold text-zinc-400 dark:text-zinc-600">—</span>
      ) : (
        <span
          className={cn(
            "font-semibold tabular-nums",
            isZero && "text-red-500 dark:text-red-400",
            !isZero && isSufficient && "text-emerald-600 dark:text-emerald-400",
            !isZero && !isSufficient && "text-amber-600 dark:text-amber-400",
          )}
        >
          {disponivel}
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only product row
// ─────────────────────────────────────────────────────────────────────────────

function ProductRowReadonly({
  item,
  decisao,
  filialOrigem,
}: {
  item: EstoqueItem;
  decisao: Decisao;
  filialOrigem: string;
}) {
  const galpoes = Object.keys(item.estoques).sort();

  // Determine the relevant location based on decision
  let location: string | undefined;
  if (decisao === "propria") {
    location = item.estoques[filialOrigem]?.localizacao;
  } else if (decisao === "transferencia") {
    // Pick the first other galpão's location
    const otherGalpao = galpoes.find((g) => g !== filialOrigem);
    location = otherGalpao ? item.estoques[otherGalpao]?.localizacao : undefined;
  }

  function isGalpaoRelevant(g: string): boolean {
    if (decisao === "propria") return g === filialOrigem;
    if (decisao === "transferencia") return g !== filialOrigem;
    return false;
  }

  return (
    <div className="flex items-start gap-3 py-2.5">
      {/* Thumbnail + quantity */}
      <div className="relative shrink-0">
        <div className="h-12 w-12 overflow-hidden rounded-lg border border-line bg-surface">
          {item.imagemUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imagemUrl}
              alt={item.sku}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Package className="h-5 w-5 text-ink-faint" aria-hidden="true" />
            </div>
          )}
        </div>
        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-900 px-1 font-mono text-[10px] font-bold text-white ring-2 ring-paper dark:bg-zinc-100 dark:text-zinc-900">
          {item.quantidadePedida}
        </span>
      </div>

      {/* SKU + description + stock */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5",
              "bg-zinc-900 font-mono text-[11px] font-bold tracking-wide text-white",
              "dark:bg-zinc-100 dark:text-zinc-900",
            )}
          >
            {item.sku}
          </span>
        </div>
        <span
          className="min-w-0 truncate text-sm font-medium text-ink"
          title={item.descricao}
        >
          {item.descricao}
        </span>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {decisao === "oc" ? (
            <>
              <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
                <ShoppingCart className="h-2.5 w-2.5" aria-hidden="true" />
                OC
              </span>
              {galpoes.map((g) => {
                const loc = item.estoques[g]?.localizacao;
                return loc ? (
                  <span key={g} className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    <MapPin className="h-2.5 w-2.5 shrink-0 text-ink-faint" aria-hidden="true" />
                    {g}: {loc}
                  </span>
                ) : null;
              })}
            </>
          ) : location ? (
            <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              <MapPin className="h-2.5 w-2.5 shrink-0 text-ink-faint" aria-hidden="true" />
              {location}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-600">sem local</span>
          )}

          <span className="h-3 w-px bg-line" aria-hidden="true" />

          {galpoes.map((g) => (
            <StockPill
              key={g}
              label={g}
              disponivel={item.estoques[g]?.deposito.disponivel ?? null}
              quantidadePedida={item.quantidadePedida}
              isRelevant={isGalpaoRelevant(g)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface PedidoCardConcluidoProps {
  pedido: Pedido;
}

export function PedidoCardConcluido({ pedido }: PedidoCardConcluidoProps) {
  const [expanded, setExpanded] = useState(false);
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
        "flex overflow-hidden border bg-paper",
        "border-line",
        "transition-all",
        expanded ? "rounded-xl shadow-sm opacity-100" : "rounded-lg opacity-75 hover:opacity-100",
      )}
      aria-label={`Pedido concluído #${pedido.numero}`}
    >
      {/* Thin color strip */}
      <div className={cn("w-1 shrink-0", stripColor)} aria-hidden="true" />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Summary row — clickable */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left"
        >
          {/* Order number */}
          <span className="shrink-0 font-mono text-sm font-bold text-ink">
            #{pedido.numero}
          </span>

          {/* Client name */}
          <span
            className="min-w-0 max-w-[120px] sm:max-w-[180px] truncate text-sm text-ink-muted"
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

          {/* Galpao */}
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

          {/* Timestamp + chevron — pushed to the right */}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {time && (
              <span className="font-mono text-xs text-ink-faint">
                {time}
              </span>
            )}
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-ink-faint transition-transform duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </span>
        </button>

        {/* Expanded details */}
        {expanded && (
          <>
            <div className="mx-3 h-px bg-line" />

            {/* Motivo */}
            {pedido.sugestaoMotivo && (
              <div className="px-4 pt-2 pb-1">
                <p className="text-xs text-ink-muted">{pedido.sugestaoMotivo}</p>
              </div>
            )}

            {/* Product rows */}
            <div className="divide-y divide-line px-4">
              {pedido.itens.map((item) => (
                <ProductRowReadonly
                  key={item.produtoId}
                  item={item}
                  decisao={decisao}
                  filialOrigem={pedido.filialOrigem}
                />
              ))}
            </div>

            {/* Footer info */}
            {(pedido.erro || pedido.marcadores?.length) && (
              <>
                <div className="mx-3 h-px bg-line" />
                <div className="flex flex-wrap items-center gap-2 px-4 py-2">
                  {pedido.marcadores?.map((m) => (
                    <span
                      key={m}
                      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    >
                      {m}
                    </span>
                  ))}
                  {pedido.erro && (
                    <span className="text-xs text-red-500">{pedido.erro}</span>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
