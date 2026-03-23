"use client";

import { cn } from "@/lib/utils";
import type { Transferencia, TransferenciaStatus } from "@/types";
import { ArrowRight, ChevronRight } from "lucide-react";

interface TransferenciaCardProps {
  transferencia: Transferencia;
  onClick: () => void;
}

const STATUS_LABELS: Record<TransferenciaStatus, string> = {
  em_andamento: "Em Andamento",
  processando: "Processando",
  concluido: "Concluído",
  cancelado: "Cancelado",
  erro: "Erro",
  revertendo: "Revertendo",
  revertido: "Revertido",
};

const STATUS_COLORS: Record<TransferenciaStatus, string> = {
  em_andamento:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  processando:
    "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  concluido:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  erro: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  cancelado:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  revertendo:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  revertido:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${min}`;
}

export function TransferenciaCard({
  transferencia,
  onClick,
}: TransferenciaCardProps) {
  const cta = transferencia.status === "em_andamento" ? "Continuar" : "Ver";

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-line bg-paper shadow-sm transition-colors hover:bg-surface text-left"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Left content */}
        <div className="min-w-0 flex-1">
          {/* Top row: origem → destino */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-ink">
              {transferencia.empresa_origem?.nome ?? "—"}
            </span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="text-sm font-semibold text-ink">
              {transferencia.empresa_destino?.nome ?? "—"}
            </span>
          </div>

          {/* Middle row: status + counts */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] font-semibold",
                STATUS_COLORS[transferencia.status],
              )}
            >
              {STATUS_LABELS[transferencia.status]}
            </span>

            <span className="text-xs tabular-nums text-ink-muted">
              {transferencia.total_itens ?? 0} itens
            </span>

            {transferencia.status === "concluido" && (
              <>
                {(transferencia.itens_sucesso ?? 0) > 0 && (
                  <span className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                    {transferencia.itens_sucesso} ok
                  </span>
                )}
                {(transferencia.itens_erro ?? 0) > 0 && (
                  <span className="text-xs tabular-nums text-red-600 dark:text-red-400">
                    {transferencia.itens_erro} erro
                  </span>
                )}
              </>
            )}
          </div>

          {/* Bottom row: operator + date */}
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span>{transferencia.usuario?.nome ?? "—"}</span>
            <span>·</span>
            <span>{formatDate(transferencia.created_at)}</span>
          </div>
        </div>

        {/* Right: CTA */}
        <div className="flex shrink-0 items-center gap-1 text-xs font-medium text-ink-muted">
          {cta}
          <ChevronRight className="h-4 w-4" />
        </div>
      </div>
    </button>
  );
}
