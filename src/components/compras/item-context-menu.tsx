"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, MoreHorizontal, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ItemContextMenuProps {
  onIndisponivel: () => void;
  onTrocarSku: () => void;
  onCancelar: () => void;
}

export function ItemContextMenu({
  onIndisponivel,
  onTrocarSku,
  onCancelar,
}: ItemContextMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickAway(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickAway);
    return () => document.removeEventListener("mousedown", handleClickAway);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-muted transition-colors hover:bg-surface",
          open && "bg-surface",
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-30 w-52 overflow-hidden rounded-lg border border-line bg-paper shadow-lg">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onIndisponivel();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs text-ink hover:bg-surface"
          >
            <Ban className="h-3.5 w-3.5 text-red-500" />
            Marcar indisponivel
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onTrocarSku();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs text-ink hover:bg-surface"
          >
            <RefreshCw className="h-3.5 w-3.5 text-amber-500" />
            Trocar SKU
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCancelar();
            }}
            className="flex w-full items-center gap-2.5 border-t border-line px-3 py-2.5 text-left text-xs text-red-600 hover:bg-red-50"
          >
            <X className="h-3.5 w-3.5" />
            Solicitar cancelamento
          </button>
        </div>
      )}
    </div>
  );
}
