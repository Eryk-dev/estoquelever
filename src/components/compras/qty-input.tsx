"use client";

import { Minus, Plus } from "lucide-react";

export function QtyInput({
  value,
  onChange,
  min = 0,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-0">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="flex h-7 w-7 items-center justify-center rounded-l-md border border-line bg-surface text-ink-muted transition-colors hover:bg-zinc-100 active:bg-zinc-200"
      >
        <Minus className="h-3 w-3" />
      </button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v)) onChange(Math.max(min, max !== undefined ? Math.min(max, v) : v));
        }}
        className="h-7 w-12 border-y border-line bg-paper text-center text-xs font-medium text-ink focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ink/20"
      />
      <button
        type="button"
        onClick={() => onChange(max !== undefined ? Math.min(max, value + 1) : value + 1)}
        className="flex h-7 w-7 items-center justify-center rounded-r-md border border-line bg-surface text-ink-muted transition-colors hover:bg-zinc-100 active:bg-zinc-200"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}
