"use client";

import { useState, useEffect } from "react";
import { X, Plus, Minus, Loader2 } from "lucide-react";

interface ParcialModalProps {
  open: boolean;
  sku: string;
  localizacao: string | null;
  quantidadePedida: number;
  loading: boolean;
  onConfirm: (qtyPega: number, locZerou: boolean) => void;
  onCancel: () => void;
}

export function ParcialModal({
  open,
  sku,
  localizacao,
  quantidadePedida,
  loading,
  onConfirm,
  onCancel,
}: ParcialModalProps) {
  const [qty, setQty] = useState(quantidadePedida);
  const [locZerou, setLocZerou] = useState(false);

  useEffect(() => {
    if (open) {
      setQty(quantidadePedida);
      setLocZerou(false);
    }
  }, [open, quantidadePedida]);

  useEffect(() => {
    if (qty < quantidadePedida) {
      setLocZerou(true);
    }
  }, [qty, quantidadePedida]);

  if (!open) return null;

  const handleQtyChange = (delta: number) => {
    setQty((prev) => Math.max(0, Math.min(quantidadePedida, prev + delta)));
  };

  const handleManualQty = (val: string) => {
    const n = parseInt(val, 10);
    if (isNaN(n)) return;
    setQty(Math.max(0, Math.min(quantidadePedida, n)));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {sku}
            </h2>
            {localizacao && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Loc: {localizacao}
              </p>
            )}
          </div>
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Quantas unidades você conseguiu pegar?
        </p>

        <div className="mb-4 flex items-center justify-center gap-3">
          <button
            onClick={() => handleQtyChange(-1)}
            disabled={loading || qty <= 0}
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:text-zinc-300"
          >
            <Minus className="h-5 w-5" />
          </button>
          <input
            type="number"
            value={qty}
            min={0}
            max={quantidadePedida}
            onChange={(e) => handleManualQty(e.target.value)}
            disabled={loading}
            className="w-24 rounded-xl border border-zinc-200 bg-white py-3 text-center text-3xl font-bold text-zinc-900 focus:border-amber-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            onClick={() => handleQtyChange(1)}
            disabled={loading || qty >= quantidadePedida}
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:text-zinc-300"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          de <strong>{quantidadePedida}</strong> esperadas
        </p>

        <label className="mb-4 flex cursor-pointer items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
          <input
            type="checkbox"
            checked={locZerou}
            onChange={(e) => setLocZerou(e.target.checked)}
            disabled={loading}
            className="h-4 w-4 rounded border-zinc-300"
          />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">
            {qty === 0
              ? "Esta loc estava vazia"
              : "Esta loc zerou (não tem mais)"}
          </span>
        </label>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 rounded-xl border border-zinc-200 py-3 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(qty, locZerou)}
            disabled={loading}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-600 py-3 font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}
