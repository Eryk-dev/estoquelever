"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

interface ExcecaoItem {
  id: string;
  sku: string;
  descricao: string;
  compra_status: string;
  fornecedor_oc: string | null;
  numero_pedido: string;
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_equivalente_fornecedor: string | null;
  compra_cancelamento_motivo: string | null;
}

interface ExcecoesBannerProps {
  excecoes: ExcecaoItem[];
  onMutated: () => void;
}

export function ExcecoesBanner({ excecoes, onMutated }: ExcecoesBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (excecoes.length === 0) return null;

  const cancelamentos = excecoes.filter((e) => e.compra_status === "cancelamento_pendente");
  const equivalentes = excecoes.filter((e) => e.compra_status === "equivalente_pendente");
  const indisponiveis = excecoes.filter((e) => e.compra_status === "indisponivel");

  return (
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-amber-50"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="text-xs font-semibold text-amber-800">
            {excecoes.length} {excecoes.length === 1 ? "item com excecao" : "itens com excecao"}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-amber-600" />
        ) : (
          <ChevronDown className="h-4 w-4 text-amber-600" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-amber-200">
          {/* Cancelamento pendente */}
          {cancelamentos.length > 0 && (
            <ExcecaoSection
              title="Cancelamento pendente"
              color="red"
              items={cancelamentos}
              onMutated={onMutated}
              renderActions={(item) => (
                <ConfirmarCancelamentoBtn itemId={item.id} onSuccess={onMutated} />
              )}
            />
          )}

          {/* Equivalente pendente */}
          {equivalentes.length > 0 && (
            <ExcecaoSection
              title="Troca de SKU pendente"
              color="amber"
              items={equivalentes}
              onMutated={onMutated}
              renderExtra={(item) => (
                <span className="text-[10px] text-ink-muted">
                  → <span className="font-mono font-medium text-ink">{item.compra_equivalente_sku}</span>
                  {item.compra_equivalente_fornecedor && (
                    <span> ({item.compra_equivalente_fornecedor})</span>
                  )}
                </span>
              )}
              renderActions={(item) => (
                <div className="flex gap-1.5">
                  <ConfirmarEquivalenteBtn itemId={item.id} onSuccess={onMutated} />
                  <DevolverBtn itemId={item.id} onSuccess={onMutated} label="Cancelar troca" />
                </div>
              )}
            />
          )}

          {/* Indisponivel */}
          {indisponiveis.length > 0 && (
            <ExcecaoSection
              title="Indisponivel"
              color="zinc"
              items={indisponiveis}
              onMutated={onMutated}
              renderActions={(item) => (
                <DevolverBtn itemId={item.id} onSuccess={onMutated} label="Devolver para fila" />
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared section ─────────────────────────────────────────────────────────

function ExcecaoSection({
  title,
  color,
  items,
  renderExtra,
  renderActions,
}: {
  title: string;
  color: "red" | "amber" | "zinc";
  items: ExcecaoItem[];
  onMutated: () => void;
  renderExtra?: (item: ExcecaoItem) => React.ReactNode;
  renderActions: (item: ExcecaoItem) => React.ReactNode;
}) {
  const headerBg = color === "red" ? "bg-red-50" : color === "amber" ? "bg-amber-50" : "bg-zinc-50";
  const headerText = color === "red" ? "text-red-800" : color === "amber" ? "text-amber-800" : "text-ink-muted";

  return (
    <div className="border-t border-amber-200/60 first:border-t-0">
      <div className={cn("px-4 py-1.5", headerBg)}>
        <span className={cn("text-[10px] font-semibold uppercase tracking-wide", headerText)}>
          {title} ({items.length})
        </span>
      </div>
      <div className="divide-y divide-amber-100">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{item.sku}</span>
                <span className="text-[10px] text-ink-faint">#{item.numero_pedido}</span>
              </div>
              <p className="truncate text-[11px] text-ink-muted">{item.descricao}</p>
              {item.compra_cancelamento_motivo && (
                <p className="mt-0.5 text-[10px] italic text-ink-faint">
                  {item.compra_cancelamento_motivo}
                </p>
              )}
              {renderExtra?.(item)}
            </div>
            <div className="shrink-0">{renderActions(item)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Action buttons ─────────────────────────────────────────────────────────

function ConfirmarCancelamentoBtn({ itemId, onSuccess }: { itemId: string; onSuccess: () => void }) {
  const [loading, setLoading] = useState(false);

  async function handle() {
    setLoading(true);
    try {
      const res = await sisoFetch(`/api/compras/itens/${itemId}/cancelamento/confirmar`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Erro ao confirmar cancelamento");
      toast.success("Cancelamento confirmado");
      onSuccess();
    } catch {
      toast.error("Erro ao confirmar cancelamento");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      Confirmar
    </button>
  );
}

function ConfirmarEquivalenteBtn({ itemId, onSuccess }: { itemId: string; onSuccess: () => void }) {
  const [loading, setLoading] = useState(false);

  async function handle() {
    setLoading(true);
    try {
      const res = await sisoFetch(`/api/compras/itens/${itemId}/equivalente/confirmar`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Erro ao confirmar troca");
      toast.success("Troca de SKU confirmada");
      onSuccess();
    } catch {
      toast.error("Erro ao confirmar troca");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
      Confirmar troca
    </button>
  );
}

function DevolverBtn({ itemId, onSuccess, label }: { itemId: string; onSuccess: () => void; label: string }) {
  const [loading, setLoading] = useState(false);

  async function handle() {
    setLoading(true);
    try {
      const res = await sisoFetch(`/api/compras/itens/${itemId}/devolver`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Erro ao devolver item");
      toast.success("Item devolvido para fila de compras");
      onSuccess();
    } catch {
      toast.error("Erro ao devolver item");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[10px] font-medium text-ink hover:bg-surface disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
      {label}
    </button>
  );
}
