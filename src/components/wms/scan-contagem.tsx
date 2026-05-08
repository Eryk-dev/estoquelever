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
      className="w-full px-3 py-3 text-lg rounded border-2 border-zinc-400 bg-transparent font-mono"
    />
  );
}
