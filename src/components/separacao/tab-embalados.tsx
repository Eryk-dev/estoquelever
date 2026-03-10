"use client";

import { useState } from "react";
import { Package, Printer } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/domain-helpers";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { EmptyState } from "@/components/ui/empty-state";
import type { PedidoSeparacao } from "./pedido-separacao-card";

interface TabEmbaladosProps {
  pedidos: PedidoSeparacao[];
  onUpdated: () => void;
}

function EtiquetaBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;

  const isFalhou = status === "falhou";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold",
        isFalhou
          ? "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
      )}
    >
      Etiqueta: {status}
    </span>
  );
}

export function TabEmbalados({ pedidos, onUpdated }: TabEmbaladosProps) {
  const { user } = useAuth();
  const isAdmin = user?.cargo === "admin";

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === pedidos.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pedidos.map((p) => p.id)));
    }
  }

  async function handleExpedir(pedidoIds: string[]) {
    const res = await sisoFetch("/api/separacao/expedir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pedido_ids: pedidoIds }),
    });

    if (res.ok) {
      const data = await res.json();
      return data.updated as number;
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Erro ao expedir");
  }

  async function handleExpedirSingle(pedidoId: string) {
    setLoadingIds((prev) => new Set(prev).add(pedidoId));
    try {
      await handleExpedir([pedidoId]);
      toast.success("Pedido expedido");
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(pedidoId);
        return next;
      });
      onUpdated();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Erro ao expedir pedido",
      );
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(pedidoId);
        return next;
      });
    }
  }

  async function handleExpedirBatch() {
    if (selected.size === 0) return;
    setBatchLoading(true);
    try {
      const count = await handleExpedir(Array.from(selected));
      toast.success(`${count} pedido${count !== 1 ? "s" : ""} expedido${count !== 1 ? "s" : ""}`);
      setSelected(new Set());
      onUpdated();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Erro ao expedir pedidos",
      );
    } finally {
      setBatchLoading(false);
    }
  }

  if (pedidos.length === 0) {
    return <EmptyState message="Nenhum pedido embalado" />;
  }

  return (
    <div className="space-y-3">
      {/* Batch actions bar */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={selected.size === pedidos.length && pedidos.length > 0}
            onChange={toggleAll}
            className="h-3.5 w-3.5 rounded border-zinc-300 accent-blue-600"
          />
          {selected.size > 0
            ? `${selected.size} selecionado${selected.size !== 1 ? "s" : ""}`
            : "Selecionar todos"}
        </label>

        <div className="flex-1" />

        {!isAdmin && (
          <button
            type="button"
            onClick={handleExpedirBatch}
            disabled={selected.size === 0 || batchLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Package className="h-3.5 w-3.5" />
            {batchLoading
              ? "Expedindo..."
              : `Expedir Selecionados (${selected.size})`}
          </button>
        )}
      </div>

      {/* Order cards */}
      {pedidos.map((pedido) => {
        const isLoading = loadingIds.has(pedido.id);
        const isChecked = selected.has(pedido.id);

        return (
          <article
            key={pedido.id}
            className={cn(
              "rounded-xl border bg-paper px-4 py-3 shadow-sm transition-colors",
              isChecked
                ? "border-blue-300 dark:border-blue-700"
                : "border-line",
            )}
            aria-label={`Pedido #${pedido.numero}`}
          >
            <div className="flex items-center gap-3">
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => toggleSelect(pedido.id)}
                className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300 accent-blue-600"
                aria-label={`Selecionar pedido ${pedido.numero}`}
              />

              {/* Order info */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className="shrink-0 font-mono text-sm font-bold text-ink">
                  #{pedido.numero}
                </span>

                <span className="h-3 w-px bg-line" aria-hidden="true" />

                {/* Packed time */}
                {pedido.embalado_em && (
                  <span className="shrink-0 text-xs text-ink-faint">
                    Embalado às {formatTime(pedido.embalado_em)}
                  </span>
                )}

                {/* Packed by */}
                {pedido.separado_por && (
                  <span className="shrink-0 text-xs text-ink-muted">
                    por {pedido.separado_por}
                  </span>
                )}

                {/* Etiqueta badge */}
                <EtiquetaBadge status={pedido.etiqueta_status} />
              </div>

              {/* Actions */}
              <div className="flex shrink-0 items-center gap-1.5">
                {/* Reimprimir Etiqueta — placeholder */}
                <button
                  type="button"
                  disabled
                  title="Impressão será configurada em breve"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-line text-ink-faint opacity-40 cursor-not-allowed"
                >
                  <Printer className="h-3.5 w-3.5" />
                </button>

                {/* Individual expedir */}
                {!isAdmin && (
                  <button
                    type="button"
                    onClick={() => handleExpedirSingle(pedido.id)}
                    disabled={isLoading}
                    className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-zinc-100 hover:text-ink disabled:opacity-50 dark:hover:bg-zinc-800"
                  >
                    {isLoading ? "Expedindo..." : "Expedir"}
                  </button>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
