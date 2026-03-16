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
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getEcommerceAbbr,
  getEcommerceColors,
  getDecisaoColors,
  getDecisaoStripColor,
  getFilialColors,
} from "@/lib/domain-helpers";
import { ObservacoesTimeline } from "./observacoes-timeline";
import type { Decisao, DepositoEstoque, EstoqueItem, Pedido } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PedidoCardProps {
  pedido: Pedido;
  onAprovar: (id: string, decisao: Decisao) => Promise<void>;
  onStockUpdated?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain helpers
// ─────────────────────────────────────────────────────────────────────────────

/** All galpão names present in the items' stock data */
function getAllGalpoes(pedido: Pedido): string[] {
  const set = new Set<string>();
  for (const item of pedido.itens) {
    for (const g of Object.keys(item.estoques)) set.add(g);
  }
  return [...set].sort();
}

function galpaoAtendeTudo(itens: EstoqueItem[], galpao: string): boolean {
  return itens.every((item) => item.estoques[galpao]?.atende ?? false);
}

function decisaoIsAvailable(decisao: Decisao, pedido: Pedido): boolean {
  if (decisao === "oc") return true;
  if (decisao === "propria") {
    return galpaoAtendeTudo(pedido.itens, pedido.filialOrigem);
  }
  // transferencia: any OTHER galpão covers all items
  for (const g of getAllGalpoes(pedido)) {
    if (g !== pedido.filialOrigem && galpaoAtendeTudo(pedido.itens, g)) return true;
  }
  return false;
}

/** Find the best transfer target galpão */
function getTransferTarget(pedido: Pedido): string {
  const galpoes = getAllGalpoes(pedido);
  // First try: a galpão that covers everything
  for (const g of galpoes) {
    if (g !== pedido.filialOrigem && galpaoAtendeTudo(pedido.itens, g)) return g;
  }
  // Fallback: the one with most coverage
  let best = "";
  let bestCount = 0;
  for (const g of galpoes) {
    if (g === pedido.filialOrigem) continue;
    const count = pedido.itens.filter((i) => i.estoques[g]?.atende).length;
    if (count > bestCount) { best = g; bestCount = count; }
  }
  return best || galpoes.find((g) => g !== pedido.filialOrigem) || "?";
}

/** Returns the relevant physical location for an item given the chosen decision */
function getRelevantLocation(item: EstoqueItem, decisao: Decisao, filialOrigem: string, pedido: Pedido): string | undefined {
  if (decisao === "propria") {
    return item.estoques[filialOrigem]?.localizacao;
  }
  if (decisao === "transferencia") {
    const target = getTransferTarget(pedido);
    return item.estoques[target]?.localizacao;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision options
// ─────────────────────────────────────────────────────────────────────────────

interface DecisaoOption {
  value: Decisao;
  label: (pedido: Pedido) => string;
}

const DECISAO_OPTIONS: DecisaoOption[] = [
  {
    value: "propria",
    label: (p) => `Própria ${p.filialOrigem}`,
  },
  {
    value: "transferencia",
    label: (p) => `Transferência ${getTransferTarget(p)}`,
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
// Editable stock pill — click the number to set the real stock in Tiny
// ─────────────────────────────────────────────────────────────────────────────

interface EditableStockPillProps {
  label: string;
  estoque: DepositoEstoque | null;
  quantidadePedida: number;
  isRelevant?: boolean;
  pedidoId: string;
  produtoId: number;
  galpao: string;
  onUpdated?: () => void;
}

function EditableStockPill({
  label, estoque, quantidadePedida, isRelevant,
  pedidoId, produtoId, galpao, onUpdated,
}: EditableStockPillProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localEstoque, setLocalEstoque] = useState(estoque);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing && !saving) setLocalEstoque(estoque);
  }, [estoque, editing, saving]);

  const disponivel = localEstoque?.disponivel ?? null;
  const saldo = localEstoque?.saldo ?? null;
  const isNull = disponivel == null;
  const isZero = !isNull && disponivel === 0;
  const isSufficient = !isNull && disponivel >= quantidadePedida;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  async function handleSave(value: string) {
    const novoSaldo = parseInt(value, 10);
    if (isNaN(novoSaldo) || novoSaldo < 0) {
      setEditing(false);
      return;
    }
    if (novoSaldo === saldo) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setEditing(false);
    try {
      const res = await fetch("/api/tiny/stock/ajustar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedidoId, produtoId, galpao, quantidade: novoSaldo, tipo: "B" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao ajustar estoque");
        return;
      }
      const result = await res.json();
      setLocalEstoque((prev) =>
        prev
          ? { ...prev, saldo: result.saldo, reservado: result.reservado, disponivel: result.disponivel }
          : prev,
      );
      toast.success(`${galpao} atualizado → saldo ${result.saldo}, disponível ${result.disponivel}`);
      onUpdated?.();
    } catch {
      toast.error("Erro de conexão ao ajustar estoque");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs">
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
          {label}
        </span>
        <input
          ref={inputRef}
          type="number"
          min="0"
          defaultValue={saldo ?? 0}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => handleSave(e.currentTarget.value)}
          className="w-12 rounded border border-zinc-400 bg-paper px-1 py-0 text-center font-mono text-xs font-semibold text-ink outline-none focus:border-zinc-900 dark:border-zinc-500 dark:focus:border-zinc-300"
        />
      </span>
    );
  }

  if (saving) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs text-zinc-400">
        <span className="text-[10px] font-medium uppercase tracking-wide">{label}</span>
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }

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
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cn(
            "font-semibold tabular-nums rounded px-1 -mx-0.5 border border-dashed border-transparent transition-all",
            "hover:border-zinc-300 hover:bg-surface dark:hover:border-zinc-600",
            "cursor-text",
            isZero && "text-red-500 dark:text-red-400",
            !isZero && isSufficient && "text-emerald-600 dark:text-emerald-400",
            !isZero && !isSufficient && "text-amber-600 dark:text-amber-400",
          )}
          title="Alterar saldo no Tiny"
        >
          {disponivel}
        </button>
      )}
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
  pedido: Pedido;
  onStockUpdated?: () => void;
}

function ProductRow({ item, decisao, pedido, onStockUpdated }: ProductRowProps) {
  const filialOrigem = pedido.filialOrigem;
  const location = getRelevantLocation(item, decisao, filialOrigem, pedido);
  const galpoes = Object.keys(item.estoques).sort();

  /** Determine which galpão is "relevant" (will be used for this decision) */
  function isGalpaoRelevant(g: string): boolean {
    if (decisao === "propria") return g === filialOrigem;
    if (decisao === "transferencia") return g !== filialOrigem;
    return false; // OC — all shown equally
  }

  return (
    <div className="flex items-start gap-3 py-2.5">
      {/* Product thumbnail + quantity badge */}
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

      {/* SKU + description + metadata */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5",
              "bg-zinc-900 font-mono text-[11px] font-bold tracking-wide text-white",
              "dark:bg-zinc-100 dark:text-zinc-900",
            )}
            title={`SKU: ${item.sku}`}
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

        {/* Location + stock numbers */}
        <div className="flex items-center gap-3">
          {decisao === "oc" ? (
            <>
              <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
                <ShoppingCart className="h-2.5 w-2.5" aria-hidden="true" />
                OC
              </span>
              {galpoes.map((g) => {
                const loc = item.estoques[g]?.localizacao;
                return loc ? <LocationTag key={g} location={`${g}: ${loc}`} /> : null;
              })}
            </>
          ) : location ? (
            <LocationTag location={location} />
          ) : (
            <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-600">sem local</span>
          )}

          <span className="h-3 w-px bg-line" aria-hidden="true" />

          {galpoes.map((g) => (
            <EditableStockPill
              key={g}
              label={g}
              estoque={item.estoques[g]?.deposito ?? null}
              quantidadePedida={item.quantidadePedida}
              isRelevant={isGalpaoRelevant(g)}
              pedidoId={pedido.id}
              produtoId={item.produtoId}
              galpao={g}
              onUpdated={onStockUpdated}
            />
          ))}
        </div>
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
              {option.label(pedido)}
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
          {option.label(pedido)}
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

export function PedidoCard({ pedido, onAprovar, onStockUpdated }: PedidoCardProps) {
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

        {/* ── HEADER ROW ─────────────────────────────────────────────────── */}
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

          {/* Empresa badge */}
          {pedido.empresaOrigemNome && (
            <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {pedido.empresaOrigemNome}
            </span>
          )}

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

          {/* Arrow + Galpao origin */}
          <span className="shrink-0 flex items-center gap-1 text-ink-faint" aria-label={`Galpão de origem: ${pedido.filialOrigem}`}>
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
              pedido={pedido}
              onStockUpdated={onStockUpdated}
            />
          ))}
        </div>

        {/* ── OBSERVATIONS ────────────────────────────────────────────────── */}
        <div className="mx-4 h-px bg-line" />
        <ObservacoesTimeline pedidoId={pedido.id} />

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
