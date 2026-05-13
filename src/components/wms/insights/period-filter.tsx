"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const OPCOES = [
  { v: 1, label: "Hoje" },
  { v: 7, label: "7d" },
  { v: 30, label: "30d" },
] as const;

export function PeriodFilter({ defaultDias = 7 }: { defaultDias?: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const atual = Number(params.get("dias") ?? defaultDias);

  function set(v: number) {
    const sp = new URLSearchParams(params);
    sp.set("dias", String(v));
    router.replace(`${pathname}?${sp.toString()}`);
  }

  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-paper p-1">
      {OPCOES.map((o) => (
        <button
          key={o.v}
          onClick={() => set(o.v)}
          className={cn(
            "rounded-lg px-3 py-1 text-xs font-semibold transition-colors",
            atual === o.v ? "bg-ink text-paper" : "text-ink-faint hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
