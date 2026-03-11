"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { sisoFetch } from "@/lib/auth-context";
import { CheckCircle2, Truck, Calendar, History, Printer, Loader2, ShoppingCart, Package, Clock, AlertTriangle, ChevronDown, MapPin } from "lucide-react";
import { PedidoTimeline } from "./pedido-timeline";
import type { StatusSeparacao } from "@/types";

export interface CompraStatsData {
  total: number;
  aguardando: number;
  comprado: number;
  recebido: number;
  indisponivel: number;
  itens: Array<{
    sku: string;
    descricao: string;
    quantidade: number;
    compra_status: string | null;
    fornecedor_oc: string | null;
  }>;
}

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
  compra_stats: CompraStatsData | null;
}

interface SeparacaoCardProps {
  pedido: SeparacaoPedido;
  checkbox?: boolean;
  checked?: boolean;
  onToggle?: (id: string) => void;
  onRefetch?: () => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

interface ItemDetail {
  id: string;
  pedido_id: string;
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade: number;
  separacao_marcado: boolean;
  localizacao: string | null;
}

export function SeparacaoCard({
  pedido,
  checkbox,
  checked,
  onToggle,
  onRefetch,
}: SeparacaoCardProps) {
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ItemDetail[] | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const isEmbalado = pedido.status_separacao === "embalado";
  const isEmSeparacao = pedido.status_separacao === "em_separacao";
  const isAguardandoOC = pedido.status_separacao === "aguardando_compra";
  const cs = pedido.compra_stats;

  // Fetch items when expanded
  useEffect(() => {
    if (!expanded || items !== null) return;
    let cancelled = false;
    setItemsLoading(true);
    sisoFetch(`/api/separacao/checklist-items?pedidos=${pedido.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setItems(data.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setItemsLoading(false);
      });
    return () => { cancelled = true; };
  }, [expanded, items, pedido.id]);

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
          : isAguardandoOC
            ? "border-amber-200 dark:border-amber-800"
            : "border-line",
        checkbox && checked && "ring-2 ring-zinc-900/10 dark:ring-zinc-100/10",
      )}
      aria-label={`Pedido #${pedido.numero_pedido}`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Checkbox */}
        {checkbox && (
          <label className="flex shrink-0 cursor-pointer items-center pt-0.5" onClick={(e) => e.stopPropagation()}>
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
          {/* Row 1: Order number + client + actions */}
          <div
            className="flex cursor-pointer items-center gap-2"
            onClick={() => setExpanded((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); } }}
          >
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

            {/* Print label (embalado only) */}
            {isEmbalado && (
              <button
                type="button"
                disabled={printing}
                onClick={async (e) => {
                  e.stopPropagation();
                  setPrinting(true);
                  try {
                    const res = await sisoFetch("/api/separacao/reimprimir", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ pedido_id: pedido.id }),
                    });
                    const body = await res.json().catch(() => ({}));
                    if (res.ok && body.status === "impresso") {
                      toast.success(`Etiqueta #${pedido.numero_pedido} enviada`);
                    } else {
                      toast.error(body.error ?? "Falha ao imprimir etiqueta");
                    }
                  } catch {
                    toast.error("Erro de conexao");
                  } finally {
                    setPrinting(false);
                  }
                }}
                className="shrink-0 rounded p-1 text-emerald-500 transition-colors hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50 dark:hover:bg-emerald-950/30"
                title="Imprimir etiqueta"
                aria-label="Imprimir etiqueta"
              >
                {printing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Printer className="h-3.5 w-3.5" />
                )}
              </button>
            )}

            {/* Timeline toggle */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setTimelineOpen((v) => !v); }}
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

            {/* Expand chevron */}
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
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

          {/* Aguardando OC: compra progress + item list */}
          {isAguardandoOC && cs && (
            <div className="mt-1.5 space-y-2">
              {/* Progress summary */}
              <div className="flex flex-wrap items-center gap-3 text-[11px]">
                {cs.aguardando > 0 && (
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <Clock className="h-3 w-3" />
                    {cs.aguardando} aguardando
                  </span>
                )}
                {cs.comprado > 0 && (
                  <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
                    <ShoppingCart className="h-3 w-3" />
                    {cs.comprado} comprado{cs.comprado !== 1 ? "s" : ""}
                  </span>
                )}
                {cs.recebido > 0 && (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <Package className="h-3 w-3" />
                    {cs.recebido} recebido{cs.recebido !== 1 ? "s" : ""}
                  </span>
                )}
                {cs.indisponivel > 0 && (
                  <span className="inline-flex items-center gap-1 text-red-500 dark:text-red-400">
                    <AlertTriangle className="h-3 w-3" />
                    {cs.indisponivel} indisponivel
                  </span>
                )}
              </div>

              {/* Progress bar */}
              {cs.total > 0 && (
                <div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div className="flex h-full">
                      {cs.recebido > 0 && (
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${(cs.recebido / cs.total) * 100}%` }}
                        />
                      )}
                      {cs.comprado > 0 && (
                        <div
                          className="h-full bg-blue-500"
                          style={{ width: `${(cs.comprado / cs.total) * 100}%` }}
                        />
                      )}
                      {cs.aguardando > 0 && (
                        <div
                          className="h-full bg-amber-400"
                          style={{ width: `${(cs.aguardando / cs.total) * 100}%` }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Item list */}
              <div className="rounded-lg border border-line bg-surface">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-line text-left text-ink-faint">
                      <th className="px-2 py-1 font-medium">SKU</th>
                      <th className="px-2 py-1 font-medium">Descricao</th>
                      <th className="px-2 py-1 font-medium text-center">Qtd</th>
                      <th className="px-2 py-1 font-medium">Fornecedor</th>
                      <th className="px-2 py-1 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cs.itens.map((item, idx) => (
                      <tr
                        key={`${item.sku}-${idx}`}
                        className="border-b border-line/50 last:border-0"
                      >
                        <td className="px-2 py-1 font-mono font-medium text-ink">
                          {item.sku}
                        </td>
                        <td className="max-w-[200px] truncate px-2 py-1 text-ink-faint" title={item.descricao}>
                          {item.descricao}
                        </td>
                        <td className="px-2 py-1 text-center font-mono text-ink">
                          {item.quantidade}
                        </td>
                        <td className="px-2 py-1 text-ink-faint">
                          {item.fornecedor_oc ?? "—"}
                        </td>
                        <td className="px-2 py-1">
                          <CompraStatusBadge status={item.compra_status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Expanded items panel */}
      {expanded && (
        <>
          <div className="mx-4 h-px bg-line" />
          <div className="px-4 py-3">
            {itemsLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />
                <span className="ml-2 text-xs text-ink-faint">Carregando itens...</span>
              </div>
            ) : items && items.length > 0 ? (
              <div className="rounded-lg border border-line bg-surface">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-line text-left text-ink-faint">
                      <th className="px-2 py-1.5 font-medium">SKU</th>
                      <th className="px-2 py-1.5 font-medium">Descricao</th>
                      <th className="px-2 py-1.5 font-medium text-center">Qtd</th>
                      <th className="px-2 py-1.5 font-medium">Localizacao</th>
                      {isEmSeparacao && (
                        <th className="px-2 py-1.5 font-medium text-center">Separado</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        className={cn(
                          "border-b border-line/50 last:border-0",
                          item.separacao_marcado && "bg-emerald-50/50 dark:bg-emerald-950/10",
                        )}
                      >
                        <td className="px-2 py-1.5 font-mono font-medium text-ink">
                          {item.sku}
                        </td>
                        <td className="max-w-[200px] truncate px-2 py-1.5 text-ink-faint" title={item.descricao}>
                          {item.descricao}
                        </td>
                        <td className="px-2 py-1.5 text-center font-mono text-ink">
                          {item.quantidade}
                        </td>
                        <td className="px-2 py-1.5">
                          {item.localizacao ? (
                            <span className="inline-flex items-center gap-1 text-ink-faint">
                              <MapPin className="h-3 w-3" />
                              {item.localizacao}
                            </span>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                        {isEmSeparacao && (
                          <td className="px-2 py-1.5 text-center">
                            {item.separacao_marcado ? (
                              <CheckCircle2 className="mx-auto h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <span className="text-ink-faint">—</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-2 text-center text-xs text-ink-faint">
                Nenhum item encontrado
              </p>
            )}
          </div>
        </>
      )}

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

// ─── Compra status badge ─────────────────────────────────────────────────────

const COMPRA_STATUS_MAP: Record<string, { label: string; className: string }> = {
  aguardando_compra: {
    label: "Aguardando",
    className: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
  },
  comprado: {
    label: "Comprado",
    className: "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400",
  },
  recebido: {
    label: "Recebido",
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
  },
  indisponivel: {
    label: "Indisponivel",
    className: "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400",
  },
};

function CompraStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-ink-faint">—</span>;
  const cfg = COMPRA_STATUS_MAP[status];
  if (!cfg) return <span className="text-ink-faint">{status}</span>;
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", cfg.className)}>
      {cfg.label}
    </span>
  );
}
