"use client";

import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Replace, X, Loader2, Package, MapPin, Boxes, ExternalLink } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { TIER_LABEL } from "@/lib/wms/trocas-equivalencia-regra";
import type {
  DetalheProduto,
  EquivalenteRapido,
  EstoqueGalpao,
} from "@/lib/cross/types";

interface CrossPopoverButtonProps {
  sku: string;
  /** Tamanho do botão */
  variant?: "icon" | "compact" | "full";
  /** Classes extras pro botão trigger */
  className?: string;
}

/**
 * Cache módulo-level pra evitar re-checagem de has-cross para o mesmo SKU
 * dentro da mesma sessão (ex: mesma SKU em vários cards).
 */
const hasCrossCache = new Map<string, boolean>();
const inFlightRequests = new Map<string, Promise<boolean>>();

async function checkHasCross(sku: string): Promise<boolean> {
  const cached = hasCrossCache.get(sku);
  if (cached !== undefined) return cached;

  const inFlight = inFlightRequests.get(sku);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const res = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/has-cross`,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { has: boolean };
      hasCrossCache.set(sku, data.has);
      return data.has;
    } catch {
      return false;
    } finally {
      inFlightRequests.delete(sku);
    }
  })();

  inFlightRequests.set(sku, promise);
  return promise;
}

type EstoquesPorSku = Record<string, Record<string, EstoqueGalpao> | "loading" | "error">;

/**
 * Botão reutilizável que abre um modal com Cross-References do SKU + estoques
 * disponíveis. Pensado para ser plugado em qualquer card do SISO onde o
 * operador possa querer ver alternativas para substituir um item.
 */
export function CrossPopoverButton({
  sku,
  variant = "icon",
  className,
}: CrossPopoverButtonProps) {
  const [aberto, setAberto] = useState(false);
  const [hasCross, setHasCross] = useState<boolean | null>(
    hasCrossCache.get(sku) ?? null,
  );

  useEffect(() => {
    if (hasCross !== null) return;  // cache hit
    let cancelado = false;
    void checkHasCross(sku).then((has) => {
      if (!cancelado) setHasCross(has);
    });
    return () => {
      cancelado = true;
    };
  }, [sku, hasCross]);

  // Não renderiza nada enquanto check ou se SKU não tem cross
  if (hasCross !== true) return null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setAberto(true);
        }}
        title="Ver alternativas (Cross)"
        className={cn(
          "shrink-0 inline-flex items-center gap-1 rounded text-cyan-600 hover:bg-cyan-50 dark:hover:bg-cyan-950/40 transition",
          variant === "icon" && "p-1",
          variant === "compact" && "px-1.5 py-0.5 text-[11px] font-semibold",
          variant === "full" && "px-2 py-1 text-xs font-medium",
          className,
        )}
      >
        <Replace className={cn(variant === "icon" ? "h-4 w-4" : "h-3.5 w-3.5")} />
        {variant !== "icon" && <span>Cross</span>}
      </button>

      {aberto && <CrossModal sku={sku} onClose={() => setAberto(false)} />}
    </>
  );
}

interface CrossModalProps {
  sku: string;
  onClose: () => void;
}

function CrossModal({ sku, onClose }: CrossModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);


  const [detalhe, setDetalhe] = useState<DetalheProduto | null>(null);
  const [detalheLoading, setDetalheLoading] = useState(true);
  const [estoquePrincipal, setEstoquePrincipal] = useState<Record<string, EstoqueGalpao> | null>(
    null,
  );
  const [estoqueLoading, setEstoqueLoading] = useState(true);
  const [equivalentes, setEquivalentes] = useState<EquivalenteRapido[] | null>(null);
  const [equivalentesLoading, setEquivalentesLoading] = useState(true);
  const [estoquesEq, setEstoquesEq] = useState<EstoquesPorSku>({});
  const [carregandoEstoques, setCarregandoEstoques] = useState(false);

  // Esc fecha
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Trava scroll do body
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  // Dispara as 3 cargas em paralelo
  useEffect(() => {
    let cancelado = false;

    void (async () => {
      try {
        const res = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(sku)}`);
        if (cancelado) return;
        if (res.ok) setDetalhe((await res.json()) as DetalheProduto);
      } catch {
        // ignora — UI mostra estado vazio
      } finally {
        if (!cancelado) setDetalheLoading(false);
      }
    })();

    void (async () => {
      try {
        const res = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(sku)}/estoque`);
        if (cancelado) return;
        if (res.ok) {
          const data = (await res.json()) as { estoque_por_galpao: Record<string, EstoqueGalpao> };
          setEstoquePrincipal(data.estoque_por_galpao ?? {});
        }
      } catch {
        // ignora
      } finally {
        if (!cancelado) setEstoqueLoading(false);
      }
    })();

    void (async () => {
      try {
        const res = await sisoFetch(
          `/api/wms/cross/produtos/${encodeURIComponent(sku)}/equivalentes-rapidos`,
        );
        if (cancelado) return;
        if (res.ok) {
          const data = (await res.json()) as { equivalentes: EquivalenteRapido[] };
          setEquivalentes(data.equivalentes ?? []);
        }
      } catch {
        // ignora
      } finally {
        if (!cancelado) setEquivalentesLoading(false);
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [sku]);

  const carregarEstoquesEq = useCallback(async () => {
    if (!equivalentes || equivalentes.length === 0) return;
    setCarregandoEstoques(true);
    setEstoquesEq((prev) => {
      const next = { ...prev };
      for (const eq of equivalentes) next[eq.sku] = "loading";
      return next;
    });
    await Promise.all(
      equivalentes.map(async (eq) => {
        try {
          const res = await sisoFetch(
            `/api/wms/cross/produtos/${encodeURIComponent(eq.sku)}/estoque`,
          );
          if (!res.ok) {
            setEstoquesEq((prev) => ({ ...prev, [eq.sku]: "error" }));
            return;
          }
          const data = (await res.json()) as {
            estoque_por_galpao: Record<string, EstoqueGalpao>;
          };
          setEstoquesEq((prev) => ({ ...prev, [eq.sku]: data.estoque_por_galpao ?? {} }));
        } catch {
          setEstoquesEq((prev) => ({ ...prev, [eq.sku]: "error" }));
        }
      }),
    );
    setCarregandoEstoques(false);
  }, [equivalentes]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white dark:bg-zinc-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Replace className="h-4 w-4 text-cyan-600" />
            <span className="font-mono text-sm font-semibold">{sku}</span>
            {detalhe?.nome && (
              <span className="text-xs text-zinc-500 truncate">— {detalhe.nome}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/cross/${encodeURIComponent(sku)}`}
              className="text-xs text-zinc-500 hover:text-zinc-700 inline-flex items-center gap-1"
              title="Abrir detalhe completo"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Fechar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {/* Produto principal */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
            {detalheLoading && (
              <div className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Carregando produto...
              </div>
            )}
            {detalhe && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-12 h-12 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
                  {detalhe.imagem_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={detalhe.imagem_url}
                      alt={detalhe.nome}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Package className="h-5 w-5 text-zinc-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{detalhe.nome}</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500 mt-0.5">
                    {detalhe.fornecedor && <span>{detalhe.fornecedor}</span>}
                    {detalhe.localizacao && (
                      <span className="inline-flex items-center gap-0.5">
                        <MapPin className="h-3 w-3" />
                        {detalhe.localizacao}
                      </span>
                    )}
                  </div>
                  {/* Estoque principal */}
                  <div className="mt-1.5 text-[11px]">
                    {estoqueLoading && (
                      <span className="text-zinc-400 inline-flex items-center gap-1">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" /> Estoque...
                      </span>
                    )}
                    {!estoqueLoading && estoquePrincipal && (
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(estoquePrincipal).map(([galpao, est]) => (
                          <span key={galpao} className="text-zinc-600 dark:text-zinc-400">
                            {galpao}:{" "}
                            <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">
                              {est.disponivel}
                            </span>
                          </span>
                        ))}
                        {Object.keys(estoquePrincipal).length === 0 && (
                          <span className="text-zinc-400">sem estoque</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Cross-references */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Alternativas{" "}
                {equivalentes !== null && (
                  <span className="text-zinc-400 normal-case font-normal">
                    ({equivalentes.length})
                  </span>
                )}
              </h3>
              {equivalentes && equivalentes.length > 0 && (
                <button
                  onClick={carregarEstoquesEq}
                  disabled={carregandoEstoques}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400 dark:hover:bg-emerald-900 disabled:opacity-50"
                >
                  {carregandoEstoques ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Boxes className="h-3 w-3" />
                  )}
                  Ver estoques
                </button>
              )}
            </div>

            {equivalentesLoading && (
              <div className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Buscando alternativas...
              </div>
            )}

            {!equivalentesLoading && equivalentes && equivalentes.length === 0 && (
              <p className="text-xs text-zinc-500">
                Nenhuma alternativa encontrada (sem OEM compartilhado nem link manual).
              </p>
            )}

            {!equivalentesLoading && equivalentes && equivalentes.length > 0 && (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {equivalentes.map((eq) => {
                  const estoqueEq = estoquesEq[eq.sku];
                  return (
                    <li key={eq.sku} className="py-2">
                      <div className="flex gap-2">
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
                            <Link
                              href={`/cross/${encodeURIComponent(eq.sku)}`}
                              className="font-mono text-xs font-bold hover:text-cyan-600"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {eq.sku}
                            </Link>
                            {eq.fornecedor && (
                              <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                                {eq.fornecedor}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                            {eq.nome}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                            {eq.localizacao && (
                              <span className="text-[10px] text-zinc-500 inline-flex items-center gap-0.5">
                                <MapPin className="h-2.5 w-2.5" />
                                {eq.localizacao}
                              </span>
                            )}
                            {(eq.origem === "link" || eq.origem === "oem+link") && (
                              <span className="px-1 py-px rounded bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-300 text-[9px] font-medium">
                                Linkado
                              </span>
                            )}
                            {eq.tier_qualidade && (
                              <span className="px-1 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-[9px] font-medium">
                                {TIER_LABEL[eq.tier_qualidade]}
                              </span>
                            )}
                            {eq.verificacao === "verificado" && (
                              <span className="px-1 py-px rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300 text-[9px] font-medium">
                                ✓ Verificado
                              </span>
                            )}
                            {eq.verificacao === "bloqueado" && (
                              <span className="px-1 py-px rounded bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300 text-[9px] font-medium">
                                ✕ Bloqueado
                              </span>
                            )}
                            {eq.oems_compartilhados.slice(0, 3).map((o) => (
                              <span
                                key={o}
                                className="px-1 py-px rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300 text-[9px] font-mono"
                              >
                                {o}
                              </span>
                            ))}
                          </div>
                          {/* Estoque inline (lazy) */}
                          {estoqueEq === "loading" && (
                            <div className="text-[10px] text-zinc-400 mt-0.5 inline-flex items-center gap-1">
                              <Loader2 className="h-2 w-2 animate-spin" /> Estoque...
                            </div>
                          )}
                          {estoqueEq === "error" && (
                            <div className="text-[10px] text-red-500 mt-0.5">
                              Erro ao consultar
                            </div>
                          )}
                          {estoqueEq && estoqueEq !== "loading" && estoqueEq !== "error" && (
                            <div className="flex flex-wrap gap-2 mt-0.5 text-[10px]">
                              {Object.entries(estoqueEq).map(([galpao, est]) => (
                                <span key={galpao} className="text-zinc-500">
                                  {galpao}:{" "}
                                  <span
                                    className={cn(
                                      "font-mono font-bold",
                                      est.disponivel > 0
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-zinc-400",
                                    )}
                                  >
                                    {est.disponivel}
                                  </span>
                                </span>
                              ))}
                              {Object.keys(estoqueEq).length === 0 && (
                                <span className="text-zinc-400">sem estoque</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
