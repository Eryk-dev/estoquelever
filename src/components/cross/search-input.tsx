"use client";

import { useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TipoBusca } from "@/lib/cross/types";

interface SearchInputProps {
  value: string;
  tipo: TipoBusca;
  onChange: (value: string) => void;
  onTipoChange: (tipo: TipoBusca) => void;
  onSubmit: () => void;
}

const TIPOS: { value: TipoBusca; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "sku", label: "SKU" },
  { value: "oem", label: "OEM" },
  { value: "nome", label: "Nome" },
];

export function SearchInput({
  value,
  tipo,
  onChange,
  onTipoChange,
  onSubmit,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Foco com tecla "/"
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-400" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="SKU, OEM ou nome do produto"
          autoFocus
          className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-10 pr-4 py-3 text-base placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </div>
      <div className="flex gap-2">
        {TIPOS.map((t) => (
          <button
            key={t.value}
            onClick={() => onTipoChange(t.value)}
            className={cn(
              "px-3 py-1 rounded-full text-sm font-medium transition",
              tipo === t.value
                ? "bg-emerald-600 text-white"
                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
