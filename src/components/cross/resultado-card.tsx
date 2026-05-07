"use client";

import Link from "next/link";
import { Package } from "lucide-react";
import type { ResultadoBusca } from "@/lib/cross/types";

const MATCH_LABEL: Record<ResultadoBusca["match"], string> = {
  sku_exato: "via SKU",
  sku_prefixo: "via SKU",
  oem: "via OEM",
  nome: "via nome",
};

interface ResultadoCardProps {
  resultado: ResultadoBusca;
}

export function ResultadoCard({ resultado }: ResultadoCardProps) {
  return (
    <Link
      href={`/cross/${encodeURIComponent(resultado.sku)}`}
      className="block rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 hover:border-emerald-400 transition"
    >
      <div className="flex gap-3">
        <div className="flex-shrink-0 w-12 h-12 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
          {resultado.imagem_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={resultado.imagem_url}
              alt={resultado.nome}
              className="w-full h-full object-cover"
            />
          ) : (
            <Package className="h-6 w-6 text-zinc-400" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm font-medium truncate">
              {resultado.sku}
            </span>
            <span className="text-xs text-zinc-500 whitespace-nowrap">
              {MATCH_LABEL[resultado.match]}
            </span>
          </div>
          <div className="text-sm text-zinc-700 dark:text-zinc-300 truncate">
            {resultado.nome}
          </div>
          {resultado.fornecedor && (
            <div className="text-xs text-zinc-500 mt-0.5">
              {resultado.fornecedor}
            </div>
          )}
          {resultado.oems.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {resultado.oems.slice(0, 4).map((o) => (
                <span
                  key={o}
                  className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-xs font-mono text-zinc-600"
                >
                  {o}
                </span>
              ))}
              {resultado.oems.length > 4 && (
                <span className="text-xs text-zinc-400">
                  +{resultado.oems.length - 4}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
