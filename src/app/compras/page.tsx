"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronDown,
  Copy,
  Loader2,
  LogOut,
  Package,
  RefreshCw,
  Settings,
  ShoppingCart,
  CheckCircle2,
} from "lucide-react";
import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { CARGO_LABELS } from "@/types";
import type { Pedido, EstoqueItem, Decisao } from "@/types";

// ─── Data fetching ──────────────────────────────────────────────────────────

async function fetchPedidosPendentes(): Promise<Pedido[]> {
  const res = await fetch("/api/pedidos?status=pendente");
  if (!res.ok) throw new Error("Erro ao carregar pedidos");
  return res.json();
}

// ─── Grouping logic ─────────────────────────────────────────────────────────

interface SkuConsolidado {
  sku: string;
  descricao: string;
  imagemUrl?: string;
  quantidadeTotal: number;
  pedidos: Array<{ id: string; numero: string; quantidade: number }>;
}

interface GrupoFornecedor {
  fornecedor: string;
  skus: SkuConsolidado[];
  pedidoIds: string[];
  totalItens: number;
  totalQuantidade: number;
}

function agruparPorFornecedor(pedidos: Pedido[]): GrupoFornecedor[] {
  // Only OC-suggested orders
  const ocPedidos = pedidos.filter((p) => p.sugestao === "oc");

  // Map: fornecedor → Map<sku, SkuConsolidado>
  const porFornecedor = new Map<string, Map<string, SkuConsolidado>>();
  const pedidosPorFornecedor = new Map<string, Set<string>>();

  for (const pedido of ocPedidos) {
    for (const item of pedido.itens) {
      const fornecedor = item.fornecedorOC ?? "Desconhecido";

      if (!porFornecedor.has(fornecedor)) {
        porFornecedor.set(fornecedor, new Map());
        pedidosPorFornecedor.set(fornecedor, new Set());
      }

      pedidosPorFornecedor.get(fornecedor)!.add(pedido.id);

      const skuMap = porFornecedor.get(fornecedor)!;
      const existing = skuMap.get(item.sku);

      if (existing) {
        existing.quantidadeTotal += item.quantidadePedida;
        // Avoid duplicating same pedido
        if (!existing.pedidos.find((p) => p.id === pedido.id)) {
          existing.pedidos.push({
            id: pedido.id,
            numero: pedido.numero,
            quantidade: item.quantidadePedida,
          });
        } else {
          const entry = existing.pedidos.find((p) => p.id === pedido.id)!;
          entry.quantidade += item.quantidadePedida;
        }
      } else {
        skuMap.set(item.sku, {
          sku: item.sku,
          descricao: item.descricao,
          imagemUrl: item.imagemUrl,
          quantidadeTotal: item.quantidadePedida,
          pedidos: [
            {
              id: pedido.id,
              numero: pedido.numero,
              quantidade: item.quantidadePedida,
            },
          ],
        });
      }
    }
  }

  // Build final array sorted by most items
  const grupos: GrupoFornecedor[] = [];

  for (const [fornecedor, skuMap] of porFornecedor) {
    const skus = [...skuMap.values()].sort((a, b) =>
      a.sku.localeCompare(b.sku),
    );
    const pedidoIds = [...(pedidosPorFornecedor.get(fornecedor) ?? [])];
    const totalQuantidade = skus.reduce((s, sk) => s + sk.quantidadeTotal, 0);

    grupos.push({
      fornecedor,
      skus,
      pedidoIds,
      totalItens: skus.length,
      totalQuantidade,
    });
  }

  return grupos.sort((a, b) => b.totalItens - a.totalItens);
}

// ─── Fornecedor card ────────────────────────────────────────────────────────

interface FornecedorCardProps {
  grupo: GrupoFornecedor;
  pedidos: Pedido[];
  onAprovarTodos: (pedidoIds: string[]) => Promise<void>;
}

function FornecedorCard({ grupo, pedidos, onAprovarTodos }: FornecedorCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);
  const [aprovados, setAprovados] = useState<Set<string>>(new Set());

  const pendentes = grupo.pedidoIds.filter((id) => !aprovados.has(id));

  async function handleAprovarTodos() {
    if (loading || pendentes.length === 0) return;
    setLoading(true);
    try {
      await onAprovarTodos(pendentes);
      setAprovados((prev) => {
        const next = new Set(prev);
        for (const id of pendentes) next.add(id);
        return next;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleCopiarSkus() {
    const text = grupo.skus
      .map((s) => `${s.sku}\t${s.descricao}\t${s.quantidadeTotal}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(
      () => toast.success("SKUs copiados para a area de transferencia"),
      () => toast.error("Erro ao copiar"),
    );
  }

  return (
    <article
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-paper shadow-sm",
        "animate-slide-up",
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface/50"
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
        >
          <ShoppingCart className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-ink">{grupo.fornecedor}</h3>
          <p className="text-[11px] text-ink-faint">
            {grupo.totalItens} SKU{grupo.totalItens !== 1 ? "s" : ""}
            {" \u00b7 "}
            {grupo.totalQuantidade} un.
            {" \u00b7 "}
            {grupo.pedidoIds.length} pedido{grupo.pedidoIds.length !== 1 ? "s" : ""}
          </p>
        </div>

        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-ink-faint transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <>
          <div className="h-px bg-line" />

          {/* SKU table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line bg-surface/50 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  <th className="py-2 pl-4 pr-2">SKU</th>
                  <th className="px-2 py-2">Produto</th>
                  <th className="px-2 py-2 text-right">Qtd</th>
                  <th className="py-2 pl-2 pr-4 text-right">Pedidos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {grupo.skus.map((sku) => (
                  <tr key={sku.sku} className="group">
                    <td className="py-2.5 pl-4 pr-2">
                      <div className="flex items-center gap-2">
                        {sku.imagemUrl ? (
                          <div className="h-8 w-8 shrink-0 overflow-hidden rounded border border-line bg-surface">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={sku.imagemUrl}
                              alt={sku.sku}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          </div>
                        ) : (
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-line bg-surface">
                            <Package className="h-3.5 w-3.5 text-ink-faint" />
                          </div>
                        )}
                        <span className="inline-flex items-center rounded-md bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wide text-white dark:bg-zinc-100 dark:text-zinc-900">
                          {sku.sku}
                        </span>
                      </div>
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-2.5 text-sm text-ink" title={sku.descricao}>
                      {sku.descricao}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-ink">
                      {sku.quantidadeTotal}
                    </td>
                    <td className="py-2.5 pl-2 pr-4 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {sku.pedidos.map((p) => (
                          <span
                            key={p.id}
                            className={cn(
                              "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-medium",
                              aprovados.has(p.id)
                                ? "bg-emerald-50 text-emerald-600 line-through dark:bg-emerald-950/40 dark:text-emerald-400"
                                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
                            )}
                            title={`Pedido #${p.numero} - ${p.quantidade} un.`}
                          >
                            #{p.numero}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer actions */}
          <div className="h-px bg-line" />
          <div className="flex items-center gap-2 px-4 py-3">
            <button
              type="button"
              onClick={handleCopiarSkus}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <Copy className="h-3 w-3" />
              Copiar SKUs
            </button>

            <div className="flex-1" />

            {pendentes.length === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Todos aprovados
              </span>
            ) : (
              <button
                type="button"
                onClick={handleAprovarTodos}
                disabled={loading}
                className={cn(
                  "btn-primary inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold",
                  "transition-all duration-150 active:scale-[0.97]",
                  loading && "cursor-not-allowed opacity-30",
                )}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Aprovando...
                  </>
                ) : (
                  <>
                    <ShoppingCart className="h-3.5 w-3.5" />
                    Aprovar {pendentes.length} pedido{pendentes.length !== 1 ? "s" : ""} como OC
                  </>
                )}
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ComprasPage() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();

  const { data: allPedidos = [], isRefetching } = useQuery({
    queryKey: ["pedidos", "pendente"],
    queryFn: fetchPedidosPendentes,
    enabled: !!user,
    refetchInterval: 30_000,
  });

  const grupos = useMemo(
    () => agruparPorFornecedor(allPedidos),
    [allPedidos],
  );

  const totalPedidos = useMemo(
    () => new Set(grupos.flatMap((g) => g.pedidoIds)).size,
    [grupos],
  );

  async function handleAprovarTodos(pedidoIds: string[]) {
    let ok = 0;
    let erros = 0;

    for (const pedidoId of pedidoIds) {
      try {
        const res = await fetch("/api/pedidos/aprovar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pedidoId,
            decisao: "oc" as Decisao,
            operadorId: user?.id,
            operadorNome: user?.nome,
          }),
        });

        if (res.ok) {
          ok++;
        } else {
          erros++;
        }
      } catch {
        erros++;
      }
    }

    if (ok > 0) {
      toast.success(`${ok} pedido${ok !== 1 ? "s" : ""} aprovado${ok !== 1 ? "s" : ""} como OC`);
    }
    if (erros > 0) {
      toast.error(`${erros} erro${erros !== 1 ? "s" : ""} ao aprovar`);
    }

    queryClient.invalidateQueries({ queryKey: ["pedidos"] });
  }

  const headerRight = (
    <>
      {user?.cargo === "admin" && (
        <Link
          href="/configuracoes"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
          title="Configuracoes"
        >
          <Settings className="h-4 w-4" />
        </Link>
      )}
      <button
        type="button"
        onClick={() => queryClient.invalidateQueries({ queryKey: ["pedidos"] })}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
        title="Atualizar"
      >
        <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
      </button>
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
        <span className="font-mono text-xs font-semibold text-ink">
          {user?.nome}
        </span>
        <span className="text-[10px] text-ink-faint">
          {user ? CARGO_LABELS[user.cargo] : ""}
        </span>
      </div>
      <button
        type="button"
        onClick={logout}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
        title="Sair"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </>
  );

  return (
    <AppShell
      title="Compras"
      subtitle="Ordens de Compra por Fornecedor"
      backHref="/"
      headerRight={headerRight}
    >
      {/* Summary */}
      {grupos.length > 0 && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-paper px-4 py-3">
          <ShoppingCart className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-ink">
            <span className="font-bold">{totalPedidos}</span> pedido{totalPedidos !== 1 ? "s" : ""} pendente{totalPedidos !== 1 ? "s" : ""}
            {" \u00b7 "}
            <span className="font-bold">{grupos.length}</span> fornecedor{grupos.length !== 1 ? "es" : ""}
          </p>
        </div>
      )}

      {/* Fornecedor cards */}
      <div className="flex flex-col gap-4">
        {grupos.length === 0 ? (
          <EmptyState message="Nenhum pedido de ordem de compra pendente." />
        ) : (
          grupos.map((grupo) => (
            <FornecedorCard
              key={grupo.fornecedor}
              grupo={grupo}
              pedidos={allPedidos}
              onAprovarTodos={handleAprovarTodos}
            />
          ))
        )}
      </div>
    </AppShell>
  );
}
