"use client";
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
    <div className="flex gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-900">
      {TABS.map((t) => (
        <button
          key={t.v}
          onClick={() => onChange(t.v)}
          className={`px-3 py-1 rounded text-sm ${value === t.v ? "bg-white dark:bg-zinc-700 shadow" : ""}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
