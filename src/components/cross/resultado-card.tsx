"use client";

import Link from "next/link";
import { useState } from "react";
import { Package, MapPin, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import type { ResultadoBusca, EquivalenteRapido } from "@/lib/cross/types";

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
  const [expanded, setExpanded] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [equivalentes, setEquivalentes] = useState<EquivalenteRapido[] | null>(
    null,
  );

  const temCross = resultado.cross_count > 0;

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (equivalentes !== null) return; // já carregado

    setCarregando(true);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(resultado.sku)}/equivalentes-rapidos`,
      );
      if (res.ok) {
        const data = (await res.json()) as { equivalentes: EquivalenteRapido[] };
        setEquivalentes(data.equivalentes);
      } else {
        setEquivalentes([]);
      }
    } catch {
      setEquivalentes([]);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      <Link
        href={`/cross/${encodeURIComponent(resultado.sku)}`}
        className="block p-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition"
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
            <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-500">
              {resultado.fornecedor && <span>{resultado.fornecedor}</span>}
              {resultado.localizacao && (
                <span className="inline-flex items-center gap-0.5">
                  <MapPin className="h-3 w-3" />
                  {resultado.localizacao}
                </span>
              )}
            </div>
            {resultado.oems.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {resultado.oems.slice(0, 5).map((o) => (
                  <span
                    key={o}
                    className="px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 text-xs font-mono"
                  >
                    {o}
                  </span>
                ))}
                {resultado.oems.length > 5 && (
                  <span className="text-xs text-zinc-400 self-center">
                    +{resultado.oems.length - 5}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </Link>

      {temCross && (
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium border-t",
            expanded
              ? "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/30 text-zinc-700 dark:text-zinc-300"
              : "border-zinc-100 dark:border-zinc-900 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30",
          )}
        >
          <span className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            Cross-References ({resultado.cross_count})
          </span>
          {carregando && <Loader2 className="h-3 w-3 animate-spin" />}
        </button>
      )}

      {expanded && (
        <div className="border-t border-zinc-100 dark:border-zinc-900 bg-zinc-50/50 dark:bg-zinc-900/40">
          {carregando && equivalentes === null && (
            <div className="px-3 py-4 text-xs text-zinc-500 flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Carregando equivalentes...
            </div>
          )}
          {equivalentes !== null && equivalentes.length === 0 && (
            <div className="px-3 py-3 text-xs text-zinc-500">
              Nenhum SKU equivalente encontrado.
            </div>
          )}
          {equivalentes !== null && equivalentes.length > 0 && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {equivalentes.map((eq) => (
                <li key={eq.sku}>
                  <Link
                    href={`/cross/${encodeURIComponent(eq.sku)}`}
                    className="flex gap-3 px-3 py-2 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/30 transition"
                  >
                    <div className="flex-shrink-0 w-9 h-9 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
                      {eq.imagem_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={eq.imagem_url}
                          alt={eq.nome}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Package className="h-4 w-4 text-zinc-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-medium truncate">
                          {eq.sku}
                        </span>
                        {eq.fornecedor && (
                          <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                            {eq.fornecedor}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                        {eq.nome}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        {(eq.origem === "link" || eq.origem === "oem+link") && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-300 text-[10px] font-medium">
                            Linkado
                          </span>
                        )}
                        {eq.oems_compartilhados.slice(0, 3).map((o) => (
                          <span
                            key={o}
                            className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300 text-[10px] font-mono"
                          >
                            {o}
                          </span>
                        ))}
                        {eq.oems_compartilhados.length > 3 && (
                          <span className="text-[10px] text-zinc-400 self-center">
                            +{eq.oems_compartilhados.length - 3}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
