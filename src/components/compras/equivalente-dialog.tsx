"use client";

import { useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";

interface Props {
  itemId: string;
  skuOriginal: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function EquivalenteDialog({ itemId, skuOriginal, onClose, onSuccess }: Props) {
  const [skuEquivalente, setSkuEquivalente] = useState("");
  const [observacao, setObservacao] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    if (!skuEquivalente.trim()) {
      toast.error("Informe o SKU equivalente");
      return;
    }

    setLoading(true);
    try {
      const res = await sisoFetch(`/api/compras/itens/${itemId}/equivalente`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku_equivalente: skuEquivalente.trim(),
          observacao: observacao.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: "Erro desconhecido" }));
        throw new Error(d.error ?? "Erro ao registrar equivalente");
      }

      toast.success(`Equivalente registrado: ${skuOriginal} → ${skuEquivalente.trim()}`);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-paper shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-semibold text-ink">Trocar SKU</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-muted hover:bg-surface">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              SKU Original
            </label>
            <p className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-muted">
              {skuOriginal}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              SKU Equivalente
            </label>
            <input
              type="text"
              value={skuEquivalente}
              onChange={(e) => setSkuEquivalente(e.target.value.toUpperCase())}
              placeholder="Ex: EW-12346"
              autoFocus
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-ink/30 focus:outline-none focus:ring-1 focus:ring-ink/20"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              Observacao (opcional)
            </label>
            <textarea
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Motivo da troca..."
              rows={2}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink placeholder:text-ink-faint focus:border-ink/30 focus:outline-none focus:ring-1 focus:ring-ink/20"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading || !skuEquivalente.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Registrar troca
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
