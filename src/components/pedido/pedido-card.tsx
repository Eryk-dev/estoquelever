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
import {
  getEcommerceAbbr,
  getEcommerceColors,
  getDecisaoColors,
  getDecisaoStripColor,
  getFilialColors,
} from "@/lib/domain-helpers";
import type { Decisao, EstoqueItem, Filial, Pedido } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PedidoCardProps {
  pedido: Pedido;
  onAprovar: (id: string, decisao: Decisao) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision options (card-specific: label function + icon)
// ─────────────────────────────────────────────────────────────────────────────

interface DecisaoOption {
  value: Decisao;
  /** Short label shown in the action row */
  label: (filialOrigem: Filial) => string;
}

const DECISAO_OPTIONS: DecisaoOption[] = [
  {
    value: "propria",
    label: (f) => `Própria ${f}`,
  },
  {
    value: "transferencia",
    label: (f) => `Transferência ${f === "CWB" ? "SP" : "CWB"}`,
  },
  {
    value: "oc",
    label: () => "Ordem de Compra",
  },
];

function getDecisaoOption(decisao: Decisao): DecisaoOption {
  return DECISAO_OPTIONS.find((c) => c.value === decisao) ?? DECISAO_OPTIONS[0]!;
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
            : "text-ink-faint",
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
      <MapPin className="h-2.5 w-2.5 shrink-0 text-ink-faint" aria-hidden="true" />
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
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">
          {item.sku}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium text-ink"
          title={item.descricao}
        >
          {item.descricao}
        </span>
        <span className="shrink-0 font-mono text-xs font-semibold text-ink-muted">
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

        <span className="h-3 w-px bg-line" aria-hidden="true" />

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

  const alternatives = DECISAO_OPTIONS.filter((c) => c.value !== current);

  return (
    <div
      ref={ref}
      className={cn(
        "absolute bottom-full left-0 z-20 mb-1 w-52 overflow-hidden rounded-lg border",
        "border-line bg-paper shadow-lg",
        "animate-fade-in",
      )}
      role="listbox"
      aria-label="Escolher outra decisão"
    >
      {alternatives.map((option) => {
        const available = decisaoIsAvailable(option.value, pedido);
        const stripColor = getDecisaoStripColor(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={false}
            disabled={!available}
            onClick={() => {
              if (available) {
                onSelect(option.value);
                onClose();
              }
            }}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors",
              available
                ? "hover:bg-surface cursor-pointer"
                : "cursor-not-allowed opacity-40",
            )}
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                stripColor,
              )}
              aria-hidden="true"
            />
            <span className="font-medium text-ink">
              {option.label(pedido.filialOrigem)}
            </span>
            {!available && (
              <span className="ml-auto text-[10px] text-ink-faint">sem estoque</span>
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
  const option = getDecisaoOption(decisao);
  const textColor = getDecisaoColors(decisao);

  const DecisaoIcon =
    decisao === "propria" ? Package :
    decisao === "transferencia" ? Truck :
    ShoppingCart;

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      {/* Decision label + chevron toggle */}
      <div className="relative flex min-w-0 flex-1 items-center gap-1.5">
        <DecisaoIcon
          className={cn("h-3.5 w-3.5 shrink-0", textColor)}
          aria-hidden="true"
        />
        <span className={cn("text-sm font-semibold truncate", textColor)}>
          {option.label(pedido.filialOrigem)}
        </span>

        {/* Chevron — opens dropdown to switch decision */}
        <button
          type="button"
          aria-label="Mudar decisão"
          aria-expanded={dropdownOpen}
          onClick={() => setDropdownOpen((v) => !v)}
          className={cn(
            "ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors",
            "text-ink-faint hover:text-ink",
            "hover:bg-surface",
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
          "btn-primary inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold",
          "transition-all duration-150 active:scale-[0.97]",
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

  const stripColor = getDecisaoStripColor(decisao);
  const ecommerceAbbr = getEcommerceAbbr(pedido.nomeEcommerce);
  const ecommerceColors = getEcommerceColors(pedido.nomeEcommerce);

  return (
    <article
      className={cn(
        "flex overflow-hidden rounded-xl border bg-paper shadow-sm",
        "border-line",
        "animate-slide-up",
      )}
      aria-label={`Pedido #${pedido.numero}`}
    >
      {/* ── LEFT COLOR STRIP ─────────────────────────────────────────────── */}
      <div
        className={cn("w-1 shrink-0 transition-colors duration-300", stripColor)}
        aria-hidden="true"
      />

      {/* ── CARD BODY ────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">

        {/* ── HEADER ROW ───────────────────────────────────────────────────
            #ORDER  CLIENT NAME (truncated)      ML   CWB
        ──────────────────────────────────────────────────────────────────── */}
        <header className="flex items-center gap-2 px-4 py-3">
          {/* Order number */}
          <span className="shrink-0 font-mono text-sm font-bold text-ink">
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
          <span className="shrink-0 flex items-center gap-1 text-ink-faint" aria-label={`Filial de origem: ${pedido.filialOrigem}`}>
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold",
                getFilialColors(pedido.filialOrigem),
              )}
            >
              {pedido.filialOrigem}
            </span>
          </span>
        </header>

        {/* ── DIVIDER ──────────────────────────────────────────────────────── */}
        <div className="mx-4 h-px bg-line" />

        {/* ── PRODUCT ROWS ─────────────────────────────────────────────────── */}
        <div className="divide-y divide-line px-4">
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
        <div className="mx-4 h-px bg-line" />

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
