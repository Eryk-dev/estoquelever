"use client";

import { formatTime } from "@/lib/domain-helpers";
import { EmptyState } from "@/components/ui/empty-state";
import type { PedidoSeparacao } from "./pedido-separacao-card";

interface TabExpedidosProps {
  pedidos: PedidoSeparacao[];
}

export function TabExpedidos({ pedidos }: TabExpedidosProps) {
  if (pedidos.length === 0) {
    return <EmptyState message="Nenhum pedido expedido" />;
  }

  return (
    <div className="space-y-2">
      {pedidos.map((pedido) => (
        <article
          key={pedido.id}
          className="flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3 shadow-sm"
          aria-label={`Pedido #${pedido.numero}`}
        >
          <span className="shrink-0 font-mono text-sm font-bold text-ink">
            #{pedido.numero}
          </span>

          <span className="h-3 w-px bg-line" aria-hidden="true" />

          <span className="shrink-0 text-xs text-ink-faint">
            {formatTime(pedido.data)}
          </span>

          <span className="h-3 w-px bg-line" aria-hidden="true" />

          <span
            className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300"
            title={pedido.cliente_nome}
          >
            {pedido.cliente_nome}
          </span>
        </article>
      ))}
    </div>
  );
}
