"use client";
import { cn } from "@/lib/utils";
import type { PerspectivaEstoque } from "@/lib/wms/types";

const TABS: { v: PerspectivaEstoque; label: string }[] = [
  { v: "produto", label: "Por produto" },
  { v: "dono", label: "Por dono fiscal" },
  { v: "galpao", label: "Por galpão" },
  { v: "localizacao", label: "Por localização" },
];

export function SaldoPerspectivaTabs({
  value,
  onChange,
}: {
  value: PerspectivaEstoque;
  onChange: (v: PerspectivaEstoque) => void;
}) {
  return (
    <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
      <div className="flex w-fit min-w-0 items-center gap-1 rounded-lg bg-surface p-1">
        {TABS.map((t) => (
          <button
            key={t.v}
            type="button"
            onClick={() => onChange(t.v)}
            className={cn(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all",
              value === t.v
                ? "bg-ink text-paper shadow-sm"
                : "text-ink-muted hover:bg-paper hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
