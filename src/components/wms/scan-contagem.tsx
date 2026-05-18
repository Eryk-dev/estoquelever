"use client";
import { useEffect, useRef } from "react";

export function ScanContagem({
  onScan,
  autoFocus = true,
  placeholder = "bipe SKU/GTIN",
}: {
  onScan: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      return;
    }
    ref.current?.focus();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      placeholder={placeholder}
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
