"use client";

import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
  tone?: "default" | "good" | "bad" | "warn";
  inverseDelta?: boolean;
}

export function KpiCard({ label, value, sub, delta, tone = "default", inverseDelta = false }: Props) {
  const deltaColor =
    delta === null || delta === undefined
      ? "text-ink-faint"
      : (inverseDelta ? delta < 0 : delta > 0)
        ? "text-emerald-600 dark:text-emerald-400"
        : (inverseDelta ? delta > 0 : delta < 0)
          ? "text-red-600 dark:text-red-400"
          : "text-ink-faint";

  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-paper p-4 transition-colors",
        tone === "good" && "border-emerald-200 dark:border-emerald-900/40",
        tone === "bad" && "border-red-200 dark:border-red-900/40",
        tone === "warn" && "border-amber-200 dark:border-amber-900/40",
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-ink">{value}</p>
      <div className="mt-1 flex items-center gap-2 text-[11px]">
        {sub && <span className="text-ink-faint">{sub}</span>}
        {(delta !== null && delta !== undefined) && (
          <span className={cn("font-semibold", deltaColor)}>
            {delta > 0 ? "+" : ""}
            {delta}%
          </span>
        )}
      </div>
    </div>
  );
}
