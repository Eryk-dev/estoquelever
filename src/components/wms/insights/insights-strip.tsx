"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Info, AlertOctagon, X, ChevronRight } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { cn } from "@/lib/utils";
import type { InsightAtivo } from "@/lib/wms/insights/types";

const SEVERITY_STYLES = {
  critico: {
    icon: AlertOctagon,
    color: "text-red-600 dark:text-red-400",
    bg: "border-red-200 bg-red-50/80 dark:border-red-900/60 dark:bg-red-950/20",
  },
  alerta: {
    icon: AlertTriangle,
    color: "text-amber-600 dark:text-amber-400",
    bg: "border-amber-200 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/20",
  },
  info: {
    icon: Info,
    color: "text-sky-600 dark:text-sky-400",
    bg: "border-sky-200 bg-sky-50/80 dark:border-sky-900/60 dark:bg-sky-950/20",
  },
} as const;

interface Props {
  insights: InsightAtivo[];
  emptyMessage?: string;
}

export function InsightsStrip({ insights, emptyMessage }: Props) {
  const qc = useQueryClient();
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const dispensar = useMutation({
    mutationFn: async (id: string) => {
      await wmsApi(`/api/wms/insights/ativos/${id}/dispensar`, { method: "POST" });
    },
    onMutate: (id) => {
      setHidden((s) => new Set(s).add(id));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  const visible = insights.filter((i) => !hidden.has(i.id));
  if (visible.length === 0) {
    if (!emptyMessage) return null;
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map((insight) => {
        const style = SEVERITY_STYLES[insight.severidade] ?? SEVERITY_STYLES.info;
        const Icon = style.icon;
        return (
          <div
            key={insight.id}
            className={cn(
              "relative flex flex-col gap-2 rounded-xl border p-3 pr-9",
              style.bg,
            )}
          >
            <button
              type="button"
              onClick={() => dispensar.mutate(insight.id)}
              className="absolute right-2 top-2 rounded p-1 text-ink-faint transition-colors hover:bg-paper/60 hover:text-ink"
              title="Dispensar"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-start gap-2">
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", style.color)} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-tight text-ink">
                  {insight.titulo}
                </p>
                <p className="mt-1 text-xs text-ink-muted">{insight.descricao}</p>
              </div>
            </div>
            {insight.link && (
              <Link
                href={insight.link}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink hover:underline"
              >
                Ver detalhe
                <ChevronRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
