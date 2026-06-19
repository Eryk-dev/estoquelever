"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Replace, X, Loader2, Package, ExternalLink } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

interface CrossPopoverButtonProps {
  sku: string;
  /** Tamanho do botão */
  variant?: "icon" | "compact" | "full";
  /** Classes extras pro botão trigger */
  className?: string;
}

interface EstoqueGalpao {
  saldo: number;
  reservado: number;
  disponivel: number;
}
interface FichaEquivalente {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status: "sugestao" | "confirmado" | "bloqueado";
  estoquePorGalpao: Record<string, EstoqueGalpao>;
}
interface Ficha {
  produto: { sku: string; descricao: string | null; imagem_url: string | null };
  nossoEstoquePorGalpao: Record<string, EstoqueGalpao>;
  equivalentes: FichaEquivalente[];
}

/**
 * Cache módulo-level pra evitar re-checagem de "tem cross?" pro mesmo SKU
 * na mesma sessão (ex: mesma SKU em vários cards). Fonte única: a ficha do
 * caderno (/api/wms/cross/produtos/[sku]); tem cross = equivalentes.length>0.
 */
const fichaCache = new Map<string, Ficha | null>();
const inFlightRequests = new Map<string, Promise<Ficha | null>>();

async function carregarFicha(sku: string): Promise<Ficha | null> {
  if (fichaCache.has(sku)) return fichaCache.get(sku) ?? null;

  const inFlight = inFlightRequests.get(sku);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const res = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(sku)}`);
      if (!res.ok) {
        fichaCache.set(sku, null);
        return null;
      }
      const data = (await res.json()) as Ficha;
      fichaCache.set(sku, data);
      return data;
    } catch {
      fichaCache.set(sku, null);
      return null;
    } finally {
      inFlightRequests.delete(sku);
    }
  })();

  inFlightRequests.set(sku, promise);
  return promise;
}

/**
 * Botão reutilizável que abre um modal com os equivalentes do SKU (caderno do
 * cross) + o NOSSO estoque (ledger). Plugável em qualquer card onde o operador
 * possa querer ver alternativas.
 */
export function CrossPopoverButton({
  sku,
  variant = "icon",
  className,
}: CrossPopoverButtonProps) {
  const [aberto, setAberto] = useState(false);
  const [temCross, setTemCross] = useState<boolean | null>(() => {
    const c = fichaCache.get(sku);
    return c === undefined ? null : (c?.equivalentes?.length ?? 0) > 0;
  });

  useEffect(() => {
    if (temCross !== null) return; // cache hit
    let cancelado = false;
    void carregarFicha(sku).then((f) => {
      if (!cancelado) setTemCross((f?.equivalentes?.length ?? 0) > 0);
    });
    return () => {
      cancelado = true;
    };
  }, [sku, temCross]);

  // Não renderiza nada enquanto checa ou se SKU não tem cross
  if (temCross !== true) return null;

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

function totalDisp(m: Record<string, EstoqueGalpao>): number {
  return Object.values(m).reduce((s, g) => s + (g.disponivel ?? 0), 0);
}

const STATUS_INFO: Record<FichaEquivalente["status"], { label: string; cls: string }> = {
  confirmado: { label: "✓ Confirmado", cls: "bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300" },
  sugestao: { label: "● Aguardando", cls: "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-300" },
  bloqueado: { label: "✕ Bloqueado", cls: "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300" },
};

function CrossModal({ sku, onClose }: CrossModalProps) {
  const [ficha, setFicha] = useState<Ficha | null>(fichaCache.get(sku) ?? null);
  const [loading, setLoading] = useState(!fichaCache.has(sku));

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

  useEffect(() => {
    let cancelado = false;
    void carregarFicha(sku).then((f) => {
      if (cancelado) return;
      setFicha(f);
      setLoading(false);
    });
    return () => {
      cancelado = true;
    };
  }, [sku]);

  // SSR guard pro createPortal (o modal só abre client-side, mas garante).
  if (typeof document === "undefined") return null;

  const equivalentes = ficha?.equivalentes ?? [];

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
            {ficha?.produto.descricao && (
              <span className="text-xs text-zinc-500 truncate">— {ficha.produto.descricao}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/wms/cross/${encodeURIComponent(sku)}`}
              className="text-xs text-zinc-500 hover:text-zinc-700 inline-flex items-center gap-1"
              title="Abrir ficha completa"
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
          {/* Nosso estoque (ledger) */}
          {ficha && (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-[11px]">
              <span className="text-zinc-500">Nosso estoque (ledger): </span>
              {Object.keys(ficha.nossoEstoquePorGalpao).length === 0 ? (
                <span className="text-zinc-400">sem estoque</span>
              ) : (
                <span className="inline-flex flex-wrap gap-2">
                  {Object.entries(ficha.nossoEstoquePorGalpao).map(([galpao, est]) => (
                    <span key={galpao} className="text-zinc-600 dark:text-zinc-400">
                      {galpao}:{" "}
                      <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">{est.disponivel}</span>
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}

          {/* Equivalentes */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
              Alternativas{" "}
              {!loading && (
                <span className="text-zinc-400 normal-case font-normal">({equivalentes.length})</span>
              )}
            </h3>

            {loading && (
              <div className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Carregando…
              </div>
            )}

            {!loading && equivalentes.length === 0 && (
              <p className="text-xs text-zinc-500">Nenhuma alternativa no caderno.</p>
            )}

            {!loading && equivalentes.length > 0 && (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {equivalentes.map((eq) => (
                  <li key={eq.sku} className="py-2">
                    <div className="flex gap-2">
                      <div className="flex-shrink-0 w-9 h-9 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
                        {eq.imagem_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={eq.imagem_url} alt={eq.descricao ?? ""} className="w-full h-full object-cover" />
                        ) : (
                          <Package className="h-4 w-4 text-zinc-400" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <Link
                            href={`/wms/cross/${encodeURIComponent(eq.sku)}`}
                            className="font-mono text-xs font-bold hover:text-cyan-600"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {eq.sku}
                          </Link>
                          <span className={cn("px-1 py-px rounded text-[9px] font-medium", STATUS_INFO[eq.status].cls)}>
                            {STATUS_INFO[eq.status].label}
                          </span>
                        </div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-400 truncate">{eq.descricao}</div>
                        <div className="flex flex-wrap gap-2 mt-0.5 text-[10px]">
                          {Object.entries(eq.estoquePorGalpao).map(([galpao, est]) => (
                            <span key={galpao} className="text-zinc-500">
                              {galpao}:{" "}
                              <span
                                className={cn(
                                  "font-mono font-bold",
                                  est.disponivel > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400",
                                )}
                              >
                                {est.disponivel}
                              </span>
                            </span>
                          ))}
                          {totalDisp(eq.estoquePorGalpao) === 0 && (
                            <span className="text-zinc-400">sem estoque</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
