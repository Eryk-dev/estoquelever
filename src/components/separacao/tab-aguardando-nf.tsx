"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getEcommerceAbbr,
  getEcommerceColors,
  DECISAO_LABELS,
  getDecisaoColors,
} from "@/lib/domain-helpers";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { EmptyState } from "@/components/ui/empty-state";
import type { PedidoSeparacao } from "./pedido-separacao-card";
import type { Decisao } from "@/types";

interface TabAguardandoNfProps {
  pedidos: PedidoSeparacao[];
  onUpdated: () => void;
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function isOverTwoHours(dataIso: string): boolean {
  try {
    return Date.now() - new Date(dataIso).getTime() > TWO_HOURS_MS;
  } catch {
    return false;
  }
}

export function TabAguardandoNf({ pedidos, onUpdated }: TabAguardandoNfProps) {
  const { user } = useAuth();
  const isAdmin = user?.cargos?.includes("admin") ?? user?.cargo === "admin";
  const [loadingId, setLoadingId] = useState<string | null>(null);

  async function handleForcarPendente(pedidoId: string) {
    setLoadingId(pedidoId);
    try {
      const res = await sisoFetch(
        `/api/separacao/${pedidoId}/forcar-pendente`,
        { method: "PATCH" },
      );
      if (res.ok) {
        toast.success("Pedido movido para Pendentes");
        onUpdated();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao forçar pendente");
      }
    } catch {
      toast.error("Erro de conexão");
    } finally {
      setLoadingId(null);
    }
  }

  if (pedidos.length === 0) {
    return <EmptyState message="Nenhum pedido aguardando nota fiscal" />;
  }

  return (
    <div className="space-y-3">
      {pedidos.map((pedido) => {
        const overdue = isOverTwoHours(pedido.data);
        const ecommerceAbbr = getEcommerceAbbr(pedido.nome_ecommerce);
        const ecommerceColors = getEcommerceColors(pedido.nome_ecommerce);
        const totalItens = pedido.itens.reduce(
          (sum, i) => sum + i.quantidade_pedida,
          0,
        );

        return (
          <article
            key={pedido.id}
            className={cn(
              "rounded-xl border bg-paper px-4 py-3 shadow-sm",
              overdue
                ? "border-amber-300 dark:border-amber-700"
                : "border-line",
            )}
            aria-label={`Pedido #${pedido.numero}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              {/* Order number */}
              <span className="shrink-0 font-mono text-sm font-bold text-ink">
                #{pedido.numero}
              </span>

              <span className="h-3 w-px bg-line" aria-hidden="true" />

              {/* Client */}
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

              {/* Decisao badge */}
              {pedido.decisao && (
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold",
                    getDecisaoColors(pedido.decisao as Decisao),
                  )}
                >
                  {DECISAO_LABELS[pedido.decisao as Decisao]}
                </span>
              )}

              {/* Items count */}
              <span className="shrink-0 text-xs text-ink-faint">
                {totalItens} {totalItens === 1 ? "item" : "itens"}
              </span>

              {/* Overdue warning */}
              {overdue && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3" />
                  Atenção
                </span>
              )}
            </div>

            {/* Admin force button */}
            {isAdmin && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => handleForcarPendente(pedido.id)}
                  disabled={loadingId === pedido.id}
                  className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-zinc-100 hover:text-ink disabled:opacity-50 dark:hover:bg-zinc-800"
                >
                  {loadingId === pedido.id
                    ? "Movendo..."
                    : "Forçar Pendente"}
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
