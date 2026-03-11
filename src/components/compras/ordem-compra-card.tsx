"use client";

import { Truck, ClipboardCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface OcItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade: number;
  compra_status: string | null;
  compra_quantidade_recebida: number;
  pedido_id: string;
  numero_pedido: string;
}

interface OrdemCompraCardProps {
  id: string;
  index: number;
  fornecedor: string;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  total_itens: number;
  itens_recebidos: number;
  itens: OcItem[];
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function daysAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Hoje";
  if (days === 1) return "Há 1 dia";
  return `Há ${days} dias`;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  comprado: {
    label: "Comprado",
    className: "bg-amber-100 text-amber-700",
  },
  parcialmente_recebido: {
    label: "Parcial",
    className: "bg-blue-100 text-blue-700",
  },
  recebido: {
    label: "Recebido",
    className: "bg-emerald-100 text-emerald-700",
  },
};

export function OrdemCompraCard({
  id,
  index,
  fornecedor,
  status,
  observacao,
  comprado_por_nome,
  comprado_em,
  total_itens,
  itens_recebidos,
  itens,
}: OrdemCompraCardProps) {
  const router = useRouter();
  const isParcial = status === "parcialmente_recebido";

  return (
    <div className="rounded-xl border border-line bg-paper overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-surface/50">
        <div className="flex items-center gap-2 min-w-0">
          <Truck className="h-4 w-4 text-ink-faint shrink-0" />
          <h3 className="text-sm font-semibold text-ink truncate">
            OC #{index} — {fornecedor}
          </h3>
          {isParcial && (
            <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
              {itens_recebidos}/{total_itens} recebidos
            </span>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted border-b border-line/50">
        {comprado_por_nome && (
          <span>
            Comprado por <span className="font-medium text-ink">{comprado_por_nome}</span> em{" "}
            {formatDate(comprado_em)}
          </span>
        )}
        {comprado_em && (
          <span className="text-ink-faint">{daysAgo(comprado_em)}</span>
        )}
      </div>

      {/* Observacao */}
      {observacao && (
        <div className="px-4 py-2 border-b border-line/50">
          <p className="text-xs text-ink-muted italic">{observacao}</p>
        </div>
      )}

      {/* Items */}
      <div className="divide-y divide-line/50">
        {itens.map((item) => {
          const badge = STATUS_BADGE[item.compra_status ?? ""] ?? null;
          return (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink truncate">
                  {item.sku}
                </p>
                <p className="text-xs text-ink-muted truncate">
                  {item.descricao}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-semibold text-ink tabular-nums">
                  {item.quantidade}un
                </span>
                <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                  #{item.numero_pedido}
                </span>
                {badge && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                      badge.className,
                    )}
                  >
                    {badge.label}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-line px-4 py-3">
        <button
          type="button"
          onClick={() => router.push(`/compras/conferencia/${id}`)}
          className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-ink/90"
        >
          <ClipboardCheck className="h-4 w-4" />
          Conferir Recebimento
        </button>
      </div>
    </div>
  );
}
