"use client";
import { useEffect, useRef } from "react";

export function ScanContagem({
  onScan,
  autoFocus = true,
}: {
  onScan: (value: string) => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      placeholder="bipe SKU/GTIN"
      onKeyDown={(e) => {
        const target = e.target as HTMLInputElement;
        if (e.key === "Enter" && target.value) {
          onScan(target.value);
          target.value = "";
        }
      }}
      className="w-full rounded-xl border-2 border-line bg-paper px-3 py-3 font-mono text-lg text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
    />
  );
}
