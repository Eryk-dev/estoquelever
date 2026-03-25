"use client";

import { useState } from "react";
import { Ban, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";

interface Props {
  itemIds: string[];
  sku: string;
  fornecedor: string;
  onClose: () => void;
  onSuccess: (pedidoCancelado: string | null) => void;
}

export function IndisponivelDialog({
  itemIds,
  sku,
  fornecedor,
  onClose,
  onSuccess,
}: Props) {
  const [motivo, setMotivo] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    let lastPedidoCancelado: string | null = null;

    try {
      for (const itemId of itemIds) {
        const res = await sisoFetch(`/api/compras/itens/${itemId}/indisponivel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo: motivo.trim() || undefined }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({ error: "Erro desconhecido" }));
          throw new Error(d.error ?? "Erro ao marcar indisponivel");
        }
        const data = await res.json();
        if (data.pedido_cancelado) lastPedidoCancelado = data.pedido_cancelado;
      }

      toast.success(`${sku} marcado como indisponivel`);
      if (lastPedidoCancelado) {
        toast.warning("Pedido cancelado — todos os itens indisponiveis");
      }
      onSuccess(lastPedidoCancelado);
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
            <Ban className="h-4 w-4 text-red-500" />
            <h2 className="text-sm font-semibold text-ink">Marcar indisponivel</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-muted hover:bg-surface">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <p className="text-xs text-ink-muted">
            Confirmar que <span className="font-semibold text-ink">{sku}</span> nao esta
            disponivel no fornecedor <span className="font-semibold text-ink">{fornecedor}</span>?
          </p>

          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo (opcional)"
            rows={2}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink placeholder:text-ink-faint focus:border-ink/30 focus:outline-none focus:ring-1 focus:ring-ink/20"
          />

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
              Confirmar
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
