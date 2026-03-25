"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";

interface Props {
  itemIds: string[];
  sku: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function CancelamentoDialog({ itemIds, sku, onClose, onSuccess }: Props) {
  const [motivo, setMotivo] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    if (!motivo.trim()) {
      toast.error("Informe o motivo do cancelamento");
      return;
    }

    setLoading(true);
    try {
      for (const itemId of itemIds) {
        const res = await sisoFetch(`/api/compras/itens/${itemId}/cancelamento`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo: motivo.trim() }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({ error: "Erro desconhecido" }));
          throw new Error(d.error ?? "Erro ao solicitar cancelamento");
        }
      }

      toast.success(`Cancelamento solicitado para ${sku}`);
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
            <X className="h-4 w-4 text-red-500" />
            <h2 className="text-sm font-semibold text-ink">Solicitar cancelamento</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-muted hover:bg-surface">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <p className="text-xs text-ink-muted">
            Solicitar cancelamento externo do item <span className="font-semibold text-ink">{sku}</span>.
            O cancelamento deve ser feito no Tiny/marketplace antes de confirmar aqui.
          </p>

          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo do cancelamento (obrigatorio)"
            rows={2}
            autoFocus
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink placeholder:text-ink-faint focus:border-ink/30 focus:outline-none focus:ring-1 focus:ring-ink/20"
          />

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading || !motivo.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Solicitar cancelamento
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
            >
              Voltar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
