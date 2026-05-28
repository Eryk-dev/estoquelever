"use client";

import { useState } from "react";
import { Loader2, ShoppingCart, UserCog } from "lucide-react";

export interface SemCoberturaModalProps {
  open: boolean;
  pedido_ids: string[];
  item_ids: string[];
  onMandarPraCompras: () => Promise<void>;
  onPedirRealocacaoManual: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Modal aberto quando o cascade da separação esgotou cobertura em todos os galpões.
 *
 * Decisão (28/05): substitui a auto-transição pra pendente_realocacao por uma
 * escolha explícita do operador:
 * - Mandar pra Compras (verde, default) → /api/wms/separacao/mandar-pra-compras
 * - Pedir realocação manual (link cinza) → /api/wms/separacao/marcar-pendente-realocacao
 *
 * Mata o loop infinito do cascade que devolvia pedidos pra /wms/pedidos Pendentes.
 */
export function SemCoberturaModal({
  open,
  pedido_ids,
  item_ids,
  onMandarPraCompras,
  onPedirRealocacaoManual,
  onCancel,
}: SemCoberturaModalProps) {
  const [loading, setLoading] = useState<"compras" | "realocacao" | null>(null);

  if (!open) return null;

  async function handleClick(acao: "compras" | "realocacao") {
    if (loading) return;
    setLoading(acao);
    try {
      if (acao === "compras") {
        await onMandarPraCompras();
      } else {
        await onPedirRealocacaoManual();
      }
    } finally {
      setLoading(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => !loading && onCancel()}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Não há saldo em nenhum galpão
        </h2>
        <p className="mb-5 text-sm text-zinc-600 dark:text-zinc-400">
          O cascade tentou achar cobertura mas nenhum galpão tem saldo pra
          completar {pedido_ids.length}{" "}
          {pedido_ids.length === 1 ? "pedido" : "pedidos"}.
        </p>

        <button
          onClick={() => handleClick("compras")}
          disabled={!!loading}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {loading === "compras" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShoppingCart className="h-4 w-4" />
          )}
          Mandar pra Compras
        </button>

        <button
          onClick={() => handleClick("realocacao")}
          disabled={!!loading}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          {loading === "realocacao" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UserCog className="h-4 w-4" />
          )}
          Pedir realocação manual (supervisor)
        </button>

        <button
          onClick={() => !loading && onCancel()}
          disabled={!!loading}
          className="mt-3 w-full text-center text-xs text-zinc-500 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          Cancelar
        </button>

        <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-500">
          {item_ids.length} item(s) será(ão) afetado(s).
        </p>
      </div>
    </div>
  );
}
