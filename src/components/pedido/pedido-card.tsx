"use client";

import { useState, useRef, useEffect } from "react";
import {
  ArrowRight,
  ChevronDown,
  Loader2,
  MapPin,
  Package,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Decisao, EstoqueItem, Filial, Pedido } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PedidoCardProps {
  pedido: Pedido;
  onAprovar: (id: string, decisao: Decisao) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision config
// ─────────────────────────────────────────────────────────────────────────────

interface DecisaoConfig {
  value: Decisao;
  /** Short label shown in the action row */
  label: (filialOrigem: Filial) => string;
  /** Strip / accent color */
  stripColor: string;
  /** Text color for the action row label */
  textColor: string;
}

const DECISAO_CONFIGS: DecisaoConfig[] = [
  {
    value: "propria",
    label: (f) => `Própria ${f}`,
    stripColor: "bg-emerald-500",
    textColor: "text-emerald-700 dark:text-emerald-400",
  },
  {
    value: "transferencia",
    label: (f) => `Transferência ${f === "CWB" ? "SP" : "CWB"}`,
    stripColor: "bg-blue-500",
    textColor: "text-blue-700 dark:text-blue-400",
  },
  {
    value: "oc",
    label: () => "Ordem de Compra",
    stripColor: "bg-amber-500",
    textColor: "text-amber-700 dark:text-amber-400",
  },
];

function getDecisaoConfig(decisao: Decisao): DecisaoConfig {
  return DECISAO_CONFIGS.find((c) => c.value === decisao) ?? DECISAO_CONFIGS[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain helpers
// ─────────────────────────────────────────────────────────────────────────────

function cwbAtendeTudo(itens: EstoqueItem[]): boolean {
  return itens.every((item) => item.cwbAtende);
}

function spAtendeTudo(itens: EstoqueItem[]): boolean {
  return itens.every((item) => item.spAtende);
}

function decisaoIsAvailable(decisao: Decisao, pedido: Pedido): boolean {
  if (decisao === "oc") return true;
  if (decisao === "propria") {
    return pedido.filialOrigem === "CWB"
      ? cwbAtendeTudo(pedido.itens)
      : spAtendeTudo(pedido.itens);
  }
  // transferencia
  return pedido.filialOrigem === "CWB"
    ? spAtendeTudo(pedido.itens)
    : cwbAtendeTudo(pedido.itens);
}

/** Returns the relevant physical location for an item given the chosen decision */
function getRelevantLocation(item: EstoqueItem, decisao: Decisao, filialOrigem: Filial): string | undefined {
  if (decisao === "propria") {
    return filialOrigem === "CWB" ? item.localizacaoCWB : item.localizacaoSP;
  }
  if (decisao === "transferencia") {
    // Picking from the OTHER filial
    return filialOrigem === "CWB" ? item.localizacaoSP : item.localizacaoCWB;
  }
  // OC — no location relevant
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// E-commerce abbreviation
// ─────────────────────────────────────────────────────────────────────────────

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
  if (nome.toLowerCase().includes("amazon"))
    return "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock number pill
// ─────────────────────────────────────────────────────────────────────────────

interface StockPillProps {
  label: string;
  disponivel: number | null | undefined;
  quantidadePedida: number;
  isRelevant?: boolean;
}

function StockPill({ label, disponivel, quantidadePedida, isRelevant }: StockPillProps) {
  const isNull = disponivel == null;
  const isZero = !isNull && disponivel === 0;
  const isSufficient = !isNull && disponivel >= quantidadePedida;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs tabular-nums",
        isNull && "text-zinc-400 dark:text-zinc-600",
        isZero && "text-red-500 dark:text-red-400",
        !isNull && !isZero && isSufficient && "text-emerald-600 dark:text-emerald-400",
        !isNull && !isZero && !isSufficient && "text-amber-600 dark:text-amber-400",
      )}
    >
      <span
        className={cn(
          "text-[10px] font-medium uppercase tracking-wide",
          isRelevant
            ? "text-zinc-600 dark:text-zinc-300"
            : "text-zinc-400 dark:text-zinc-500",
        )}
      >
        {label}
      </span>
      <span className="font-semibold">{isNull ? "—" : String(disponivel)}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Location tag
// ─────────────────────────────────────────────────────────────────────────────

function LocationTag({ location }: { location: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      <MapPin className="h-2.5 w-2.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
      {location}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Product row (2 lines per item)
// ─────────────────────────────────────────────────────────────────────────────

interface ProductRowProps {
  item: EstoqueItem;
  decisao: Decisao;
  filialOrigem: Filial;
}

function ProductRow({ item, decisao, filialOrigem }: ProductRowProps) {
  const location = getRelevantLocation(item, decisao, filialOrigem);
  const cwbIsRelevant =
    decisao === "propria" ? filialOrigem === "CWB" : filialOrigem !== "CWB";
  const spIsRelevant =
    decisao === "propria" ? filialOrigem === "SP" : filialOrigem !== "SP";

  return (
    <div className="flex flex-col gap-0.5 py-2">
      {/* Line 1: SKU + product name + quantity */}
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
          {item.sku}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 dark:text-zinc-100"
          title={item.descricao}
        >
          {item.descricao}
        </span>
        <span className="shrink-0 font-mono text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          &times;{item.quantidadePedida}
        </span>
      </div>

      {/* Line 2: location + stock numbers */}
      <div className="flex items-center gap-3">
        {location ? (
          <LocationTag location={location} />
        ) : decisao !== "oc" ? (
          <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-600">sem local</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
            <ShoppingCart className="h-2.5 w-2.5" aria-hidden="true" />
            OC
          </span>
        )}

        <span className="h-3 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />

        <StockPill
          label="CWB"
          disponivel={item.estoqueCWB?.disponivel}
          quantidadePedida={item.quantidadePedida}
          isRelevant={cwbIsRelevant && decisao !== "oc"}
        />
        <StockPill
          label="SP"
          disponivel={item.estoqueSP?.disponivel}
          quantidadePedida={item.quantidadePedida}
          isRelevant={spIsRelevant && decisao !== "oc"}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision dropdown — shows alternatives when chevron is clicked
// ─────────────────────────────────────────────────────────────────────────────

interface DecisaoDropdownProps {
  pedido: Pedido;
  current: Decisao;
  onSelect: (d: Decisao) => void;
  onClose: () => void;
}

function DecisaoDropdown({ pedido, current, onSelect, onClose }: DecisaoDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const alternatives = DECISAO_CONFIGS.filter((c) => c.value !== current);

  return (
    <div
      ref={ref}
      className={cn(
        "absolute bottom-full left-0 z-20 mb-1 w-52 overflow-hidden rounded-lg border",
        "border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900",
        "animate-fade-in",
      )}
      role="listbox"
      aria-label="Escolher outra decisão"
    >
      {alternatives.map((config) => {
        const available = decisaoIsAvailable(config.value, pedido);
        return (
          <button
            key={config.value}
            type="button"
            role="option"
            aria-selected={false}
            disabled={!available}
            onClick={() => {
              if (available) {
                onSelect(config.value);
                onClose();
              }
            }}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors",
              available
                ? "hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer"
                : "cursor-not-allowed opacity-40",
            )}
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                config.stripColor,
              )}
              aria-hidden="true"
            />
            <span className="font-medium text-zinc-800 dark:text-zinc-100">
              {config.label(pedido.filialOrigem)}
            </span>
            {!available && (
              <span className="ml-auto text-[10px] text-zinc-400">sem estoque</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Action row
// ─────────────────────────────────────────────────────────────────────────────

interface ActionRowProps {
  pedido: Pedido;
  decisao: Decisao;
  loading: boolean;
  onSelectDecisao: (d: Decisao) => void;
  onAprovar: () => void;
}

function ActionRow({ pedido, decisao, loading, onSelectDecisao, onAprovar }: ActionRowProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const config = getDecisaoConfig(decisao);

  const DecisaoIcon =
    decisao === "propria" ? Package :
    decisao === "transferencia" ? Truck :
    ShoppingCart;

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      {/* Decision label + chevron toggle */}
      <div className="relative flex min-w-0 flex-1 items-center gap-1.5">
        <DecisaoIcon
          className={cn("h-3.5 w-3.5 shrink-0", config.textColor)}
          aria-hidden="true"
        />
        <span className={cn("text-sm font-semibold truncate", config.textColor)}>
          {config.label(pedido.filialOrigem)}
        </span>

        {/* Chevron — opens dropdown to switch decision */}
        <button
          type="button"
          aria-label="Mudar decisão"
          aria-expanded={dropdownOpen}
          onClick={() => setDropdownOpen((v) => !v)}
          className={cn(
            "ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors",
            "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200",
            "hover:bg-zinc-100 dark:hover:bg-zinc-800",
            dropdownOpen && "bg-zinc-100 dark:bg-zinc-800",
          )}
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-150",
              dropdownOpen && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>

        {/* Dropdown popover */}
        {dropdownOpen && (
          <DecisaoDropdown
            pedido={pedido}
            current={decisao}
            onSelect={onSelectDecisao}
            onClose={() => setDropdownOpen(false)}
          />
        )}
      </div>

      {/* Approve button */}
      <button
        type="button"
        onClick={onAprovar}
        disabled={loading}
        aria-busy={loading}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white",
          "transition-all duration-150 active:scale-[0.97]",
          "bg-zinc-900 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2",
          loading && "cursor-not-allowed opacity-30",
        )}
      >
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <span>Aprovando</span>
          </>
        ) : (
          <>
            <span>Aprovar</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </>
        )}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main PedidoCard — Dispatch Console style
// ─────────────────────────────────────────────────────────────────────────────

export function PedidoCard({ pedido, onAprovar }: PedidoCardProps) {
  const [decisao, setDecisao] = useState<Decisao>(pedido.sugestao);
  const [loading, setLoading] = useState(false);

  async function handleAprovar() {
    if (loading) return;
    setLoading(true);
    try {
      await onAprovar(pedido.id, decisao);
    } finally {
      setLoading(false);
    }
  }

  const config = getDecisaoConfig(decisao);
  const ecommerceAbbr = getEcommerceAbbr(pedido.nomeEcommerce);
  const ecommerceColors = getEcommerceColors(pedido.nomeEcommerce);

  return (
    <article
      className={cn(
        "flex overflow-hidden rounded-xl border bg-white shadow-sm",
        "border-zinc-200 dark:border-zinc-700/60 dark:bg-zinc-900",
        "animate-slide-up",
      )}
      aria-label={`Pedido #${pedido.numero}`}
    >
      {/* ── LEFT COLOR STRIP ─────────────────────────────────────────────── */}
      <div
        className={cn("w-1 shrink-0 transition-colors duration-300", config.stripColor)}
        aria-hidden="true"
      />

      {/* ── CARD BODY ────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">

        {/* ── HEADER ROW ───────────────────────────────────────────────────
            #ORDER  CLIENT NAME (truncated)      ML   CWB
        ──────────────────────────────────────────────────────────────────── */}
        <header className="flex items-center gap-2 px-4 py-3">
          {/* Order number */}
          <span className="shrink-0 font-mono text-sm font-bold text-zinc-900 dark:text-zinc-50">
            #{pedido.numero}
          </span>

          {/* Client name */}
          <span
            className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300"
            title={pedido.cliente.nome}
          >
            {pedido.cliente.nome}
          </span>

          {/* E-commerce abbreviation badge */}
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide",
              ecommerceColors,
            )}
            title={pedido.nomeEcommerce}
          >
            {ecommerceAbbr}
          </span>

          {/* Arrow + Filial origin */}
          <span className="shrink-0 flex items-center gap-1 text-zinc-400 dark:text-zinc-500" aria-label={`Filial de origem: ${pedido.filialOrigem}`}>
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold",
                pedido.filialOrigem === "CWB"
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                  : "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
              )}
            >
              {pedido.filialOrigem}
            </span>
          </span>
        </header>

        {/* ── DIVIDER ──────────────────────────────────────────────────────── */}
        <div className="mx-4 h-px bg-zinc-100 dark:bg-zinc-800" />

        {/* ── PRODUCT ROWS ─────────────────────────────────────────────────── */}
        <div className="divide-y divide-zinc-100 px-4 dark:divide-zinc-800">
          {pedido.itens.map((item) => (
            <ProductRow
              key={item.produtoId}
              item={item}
              decisao={decisao}
              filialOrigem={pedido.filialOrigem}
            />
          ))}
        </div>

        {/* ── DIVIDER ──────────────────────────────────────────────────────── */}
        <div className="mx-4 h-px bg-zinc-100 dark:bg-zinc-800" />

        {/* ── ACTION ROW ───────────────────────────────────────────────────── */}
        <ActionRow
          pedido={pedido}
          decisao={decisao}
          loading={loading}
          onSelectDecisao={setDecisao}
          onAprovar={handleAprovar}
        />
      </div>
    </article>
  );
}
