"use client";

import Link from "next/link";
import { Package } from "lucide-react";
import type { Equivalente } from "@/lib/cross/types";

interface EquivalentesListProps {
  equivalentes: Equivalente[];
}

export function EquivalentesList({ equivalentes }: EquivalentesListProps) {
  if (equivalentes.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h3 className="text-sm font-semibold mb-2">Equivalentes</h3>
        <p className="text-sm text-zinc-500">
          Nenhum SKU compartilha OEM com este produto.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <h3 className="text-sm font-semibold mb-3">
        Equivalentes ({equivalentes.length})
      </h3>
      <div className="space-y-2">
        {equivalentes.map((eq) => (
          <Link
            key={eq.sku}
            href={`/cross/${encodeURIComponent(eq.sku)}`}
            className="flex gap-3 p-2 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
              {eq.imagem_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={eq.imagem_url} alt={eq.nome} className="w-full h-full object-cover" />
              ) : (
                <Package className="h-5 w-5 text-zinc-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm font-medium truncate">{eq.sku}</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                {eq.nome}
              </div>
              <div className="flex flex-wrap gap-2 mt-1 text-xs">
                {Object.entries(eq.estoque_por_galpao).map(([galpao, est]) => (
                  <span key={galpao} className="text-zinc-500">
                    {galpao}: <span className="font-mono font-semibold">{est.disponivel}</span>
                  </span>
                ))}
                <span className="text-zinc-400">
                  · OEM: {eq.oems_compartilhados.slice(0, 2).join(", ")}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
