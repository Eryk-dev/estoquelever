"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, X, Loader2, Link2, MapPin, Boxes } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import type { EquivalenteRapido, EstoqueGalpao } from "@/lib/cross/types";

interface LinkListEditorProps {
  sku: string;
  onChange: () => void;
}

type EstoquesPorSku = Record<string, Record<string, EstoqueGalpao> | "loading" | "error">;

/**
 * Editor de links manuais entre SKUs. Lista os equivalentes que vieram
 * por link manual (origem 'link' ou 'oem+link') e permite criar/remover.
 */
export function LinkListEditor({ sku, onChange }: LinkListEditorProps) {
  const [links, setLinks] = useState<EquivalenteRapido[]>([]);
  const [adicionando, setAdicionando] = useState(false);
  const [novoSku, setNovoSku] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [estoques, setEstoques] = useState<EstoquesPorSku>({});
  const [carregandoEstoques, setCarregandoEstoques] = useState(false);

  async function carregarEstoques() {
    if (links.length === 0) return;
    setCarregandoEstoques(true);
    setEstoques((prev) => {
      const next = { ...prev };
      for (const link of links) next[link.sku] = "loading";
      return next;
    });
    await Promise.all(
      links.map(async (link) => {
        try {
          const res = await sisoFetch(
            `/api/cross/produtos/${encodeURIComponent(link.sku)}/estoque`,
          );
          if (!res.ok) {
            setEstoques((prev) => ({ ...prev, [link.sku]: "error" }));
            return;
          }
          const data = (await res.json()) as {
            estoque_por_galpao: Record<string, EstoqueGalpao>;
          };
          setEstoques((prev) => ({ ...prev, [link.sku]: data.estoque_por_galpao ?? {} }));
        } catch {
          setEstoques((prev) => ({ ...prev, [link.sku]: "error" }));
        }
      }),
    );
    setCarregandoEstoques(false);
  }

  async function carregar() {
    setCarregando(true);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/equivalentes-rapidos`,
      );
      if (!res.ok) {
        setLinks([]);
        return;
      }
      const data = (await res.json()) as { equivalentes: EquivalenteRapido[] };
      // Filtra só os que vieram por link manual (origem 'link' ou 'oem+link')
      setLinks(
        (data.equivalentes ?? []).filter(
          (e) => e.origem === "link" || e.origem === "oem+link",
        ),
      );
    } catch {
      setLinks([]);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sku]);

  async function adicionar() {
    const skuAlvo = novoSku.trim().toUpperCase();
    if (!skuAlvo) {
      toast.error("Informe o SKU para linkar");
      return;
    }
    if (skuAlvo === sku.toUpperCase()) {
      toast.error("Não dá para linkar um SKU a ele mesmo");
      return;
    }
    setSalvando(true);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/links`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sku_alvo: skuAlvo }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Erro ao linkar produto");
        return;
      }
      toast.success(`Link criado com ${skuAlvo}`);
      setNovoSku("");
      setAdicionando(false);
      void carregar();
      onChange();
    } catch {
      toast.error("Erro ao linkar");
    } finally {
      setSalvando(false);
    }
  }

  async function remover(skuAlvo: string) {
    if (!confirm(`Remover link com "${skuAlvo}"?`)) return;
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/links/${encodeURIComponent(skuAlvo)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao remover link");
        return;
      }
      toast.success("Link removido");
      void carregar();
      onChange();
    } catch {
      toast.error("Erro ao remover");
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Link2 className="h-4 w-4 text-blue-600" />
          Produtos linkados
        </h3>
        <div className="flex items-center gap-2">
          {links.length > 0 && (
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
          {!adicionando && (
            <button
              onClick={() => setAdicionando(true)}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
            >
              <Plus className="h-3.5 w-3.5" /> Linkar produto
            </button>
          )}
        </div>
      </div>

      {adicionando && (
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={novoSku}
            onChange={(e) => setNovoSku(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") adicionar();
              if (e.key === "Escape") {
                setAdicionando(false);
                setNovoSku("");
              }
            }}
            autoFocus
            placeholder="SKU do produto a linkar"
            className="flex-1 rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1 text-sm font-mono"
          />
          <button
            onClick={adicionar}
            disabled={salvando}
            className="px-3 py-1 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {salvando && <Loader2 className="h-3 w-3 animate-spin" />}
            Linkar
          </button>
          <button
            onClick={() => {
              setAdicionando(false);
              setNovoSku("");
            }}
            className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-700"
          >
            Cancelar
          </button>
        </div>
      )}

      {carregando ? (
        <div className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> Carregando...
        </div>
      ) : links.length === 0 ? (
        <p className="text-sm text-zinc-500">Nenhum produto linkado manualmente.</p>
      ) : (
        <ul className="space-y-1">
          {links.map((link) => {
            const estoqueLink = estoques[link.sku];
            return (
              <li
                key={link.sku}
                className="group px-2 py-1.5 rounded bg-zinc-50 dark:bg-zinc-800/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/cross/${encodeURIComponent(link.sku)}`}
                    className="flex-1 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5"
                  >
                    <span className="font-mono text-sm font-medium">{link.sku}</span>
                    <span className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                      {link.nome}
                    </span>
                    {link.fornecedor && (
                      <span className="text-[11px] text-zinc-500">{link.fornecedor}</span>
                    )}
                    {link.localizacao && (
                      <span className="text-[11px] text-zinc-500 inline-flex items-center gap-0.5">
                        <MapPin className="h-3 w-3" />
                        {link.localizacao}
                      </span>
                    )}
                    {link.origem === "oem+link" && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300 text-[10px] font-medium whitespace-nowrap">
                        + OEM
                      </span>
                    )}
                  </Link>
                  <button
                    onClick={() => remover(link.sku)}
                    className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-600"
                    title="Remover link"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {estoqueLink === "loading" && (
                  <div className="mt-1 text-[11px] text-zinc-400 inline-flex items-center gap-1">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    Consultando estoque...
                  </div>
                )}
                {estoqueLink === "error" && (
                  <div className="mt-1 text-[11px] text-red-500">
                    Erro ao consultar estoque
                  </div>
                )}
                {estoqueLink && estoqueLink !== "loading" && estoqueLink !== "error" && (
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                    {Object.entries(estoqueLink).map(([galpao, est]) => (
                      <span key={galpao} className="text-zinc-500">
                        {galpao}:{" "}
                        <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                          {est.disponivel}
                        </span>
                      </span>
                    ))}
                    {Object.keys(estoqueLink).length === 0 && (
                      <span className="text-zinc-400">sem estoque cadastrado</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
