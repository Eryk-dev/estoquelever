"use client";

import { Check, Circle, MapPin, MapPinOff } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SeparacaoItem {
  produto_id: number;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade_pedida: number;
  quantidade_bipada: number;
  bipado_completo: boolean;
  localizacao: string | null;
}

interface ItemSeparacaoRowProps {
  item: SeparacaoItem;
}

export function ItemSeparacaoRow({ item }: ItemSeparacaoRowProps) {
  const done = item.bipado_completo;

  return (
    <div
      className={cn(
        "flex items-center gap-3 py-2.5 transition-colors",
        done && "bg-emerald-50/50 dark:bg-emerald-950/20",
      )}
    >
      {/* Status icon */}
      {done ? (
        <Check
          className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-label="Bipado"
        />
      ) : (
        <Circle
          className="h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600"
          aria-label="Pendente"
        />
      )}

      {/* SKU */}
      <span
        className={cn(
          "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wide",
          done
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
            : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
        )}
      >
        {item.sku}
      </span>

      {/* Description */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          done
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-ink",
        )}
        title={item.descricao}
      >
        {item.descricao}
      </span>

      {/* Location badge */}
      {item.localizacao ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          <MapPin className="h-3 w-3 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
          {item.localizacao}
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-600">
          <MapPinOff className="h-3 w-3" aria-hidden="true" />
          Sem localização
        </span>
      )}

      {/* Bip progress */}
      <span
        className={cn(
          "shrink-0 font-mono text-xs font-semibold tabular-nums",
          done
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-zinc-500 dark:text-zinc-400",
        )}
      >
        {item.quantidade_bipada}/{item.quantidade_pedida}
      </span>
    </div>
  );
}
