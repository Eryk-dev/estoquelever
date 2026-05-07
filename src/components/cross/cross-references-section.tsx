"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package, MapPin, Loader2, Boxes } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import type { EquivalenteRapido, EstoqueGalpao } from "@/lib/cross/types";

interface CrossReferencesSectionProps {
  sku: string;
}

type EstoquesPorSku = Record<string, Record<string, EstoqueGalpao> | "loading" | "error">;

/**
 * Seção "Cross-References" no detalhe do produto.
 *
 * Lista TODOS os equivalentes (por OEM compartilhado + links manuais),
 * carregando do endpoint leve /equivalentes-rapidos (cache only, sem
 * chamada Tiny). Cada item mostra origem ('Linkado' ou OEM em comum).
 */
export function CrossReferencesSection({ sku }: CrossReferencesSectionProps) {
  const [equivalentes, setEquivalentes] = useState<EquivalenteRapido[] | null>(
    null,
  );
  const [carregando, setCarregando] = useState(true);
  const [estoques, setEstoques] = useState<EstoquesPorSku>({});
  const [carregandoEstoques, setCarregandoEstoques] = useState(false);

  async function carregarEstoques() {
    if (!equivalentes || equivalentes.length === 0) return;
    setCarregandoEstoques(true);
    // Marca todos como loading
    setEstoques((prev) => {
      const next = { ...prev };
      for (const eq of equivalentes) next[eq.sku] = "loading";
      return next;
    });

    // Dispara em paralelo
    await Promise.all(
      equivalentes.map(async (eq) => {
        try {
          const res = await sisoFetch(
            `/api/cross/produtos/${encodeURIComponent(eq.sku)}/estoque`,
          );
          if (!res.ok) {
            setEstoques((prev) => ({ ...prev, [eq.sku]: "error" }));
            return;
          }
          const data = (await res.json()) as {
            estoque_por_galpao: Record<string, EstoqueGalpao>;
          };
          setEstoques((prev) => ({ ...prev, [eq.sku]: data.estoque_por_galpao ?? {} }));
        } catch {
          setEstoques((prev) => ({ ...prev, [eq.sku]: "error" }));
        }
      }),
    );
    setCarregandoEstoques(false);
  }

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    void (async () => {
      try {
        const res = await sisoFetch(
          `/api/cross/produtos/${encodeURIComponent(sku)}/equivalentes-rapidos`,
        );
        if (cancelado) return;
        if (!res.ok) {
          setEquivalentes([]);
          return;
        }
        const data = (await res.json()) as { equivalentes: EquivalenteRapido[] };
        setEquivalentes(data.equivalentes ?? []);
      } catch {
        if (!cancelado) setEquivalentes([]);
      } finally {
        if (!cancelado) setCarregando(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [sku]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          Cross-References{" "}
          {equivalentes !== null && (
            <span className="text-xs text-zinc-500 font-normal">
              ({equivalentes.length})
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {equivalentes && equivalentes.length > 0 && (
            <button
              onClick={carregarEstoques}
              disabled={carregandoEstoques}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400 dark:hover:bg-emerald-900 disabled:opacity-50"
            >
              {carregandoEstoques ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Boxes className="h-3 w-3" />
              )}
              {carregandoEstoques ? "Carregando..." : "Ver estoques"}
            </button>
          )}
          {carregando && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
        </div>
      </div>

      {!carregando && equivalentes !== null && equivalentes.length === 0 && (
        <p className="text-sm text-zinc-500">
          Nenhum SKU equivalente encontrado (sem OEM compartilhado nem link
          manual). Use &quot;Linkar produto&quot; acima para adicionar.
        </p>
      )}

      {!carregando && equivalentes !== null && equivalentes.length > 0 && (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {equivalentes.map((eq) => (
            <li key={eq.sku}>
              <Link
                href={`/cross/${encodeURIComponent(eq.sku)}`}
                className="flex gap-3 px-2 py-2 -mx-2 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
                  {eq.imagem_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={eq.imagem_url}
                      alt={eq.nome}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Package className="h-5 w-5 text-zinc-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-medium truncate">
                      {eq.sku}
                    </span>
                    {eq.fornecedor && (
                      <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                        {eq.fornecedor}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                    {eq.nome}
                  </div>
                  {eq.localizacao && (
                    <div className="text-[11px] text-zinc-500 inline-flex items-center gap-0.5 mt-0.5">
                      <MapPin className="h-3 w-3" />
                      {eq.localizacao}
                    </div>
                  )}
                  {/* Estoque inline (carrega sob demanda via botão) */}
                  {estoques[eq.sku] === "loading" && (
                    <div className="text-[11px] text-zinc-400 mt-1 inline-flex items-center gap-1">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      Consultando estoque...
                    </div>
                  )}
                  {estoques[eq.sku] === "error" && (
                    <div className="text-[11px] text-red-500 mt-1">
                      Erro ao consultar estoque
                    </div>
                  )}
                  {estoques[eq.sku] && estoques[eq.sku] !== "loading" && estoques[eq.sku] !== "error" && (
                    <div className="flex flex-wrap gap-2 mt-1 text-[11px]">
                      {Object.entries(estoques[eq.sku] as Record<string, EstoqueGalpao>).map(
                        ([galpao, est]) => (
                          <span key={galpao} className="text-zinc-500">
                            {galpao}:{" "}
                            <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                              {est.disponivel}
                            </span>
                          </span>
                        ),
                      )}
                      {Object.keys(estoques[eq.sku] as Record<string, EstoqueGalpao>).length === 0 && (
                        <span className="text-zinc-400">sem estoque cadastrado</span>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    {(eq.origem === "link" || eq.origem === "oem+link") && (
                      <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-300 text-[10px] font-medium">
                        Linkado
                      </span>
                    )}
                    {eq.oems_compartilhados.slice(0, 4).map((o) => (
                      <span
                        key={o}
                        className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300 text-[10px] font-mono"
                      >
                        {o}
                      </span>
                    ))}
                    {eq.oems_compartilhados.length > 4 && (
                      <span className="text-[10px] text-zinc-400 self-center">
                        +{eq.oems_compartilhados.length - 4}
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
  );
}
