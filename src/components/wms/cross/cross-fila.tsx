"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ProdutoComparador, type LadoComparacao } from "@/components/wms/produto-lightbox";
import { sisoFetch } from "@/lib/auth-context";
import {
  filtrarSugestoesPorOrigem,
  origemSugestao,
  type FiltroOrigemSugestao,
} from "@/lib/cross/equivalencias-core";

interface ProdLado {
  sku: string;
  descricao: string | null;
  imagens: string[] | null;
  imagem_url: string | null;
}
interface FilaItem {
  id: number;
  sku_a: string;
  sku_b: string;
  fonte: string;
  a: ProdLado | null;
  b: ProdLado | null;
  oem_compartilhado?: string[];
}

function imgs(p: ProdLado | null): string[] {
  if (!p) return [];
  if (p.imagens && p.imagens.length) return p.imagens;
  return p.imagem_url ? [p.imagem_url] : [];
}

/** Painel de uma peça: foto (cabe na viewport) + miniaturas pra trocar a
 *  foto inline + SKU/descrição. Clicar na foto abre o comparador full-screen. */
function Pane({ rotulo, prod, onZoom }: { rotulo: string; prod: ProdLado | null; onZoom: () => void }) {
  const fotos = imgs(prod);
  // idx volta a 0 quando a fila anda: o Pane é remontado via `key={sku}`.
  const [idx, setIdx] = useState(0);
  const atual = fotos[Math.min(idx, Math.max(fotos.length - 1, 0))];

  return (
    <div className="wms-cf-pane">
      <div className="wms-cf-rotulo">{rotulo}</div>
      <div className="wms-cf-stage" onClick={onZoom} role="button" tabIndex={-1} aria-label="Ampliar fotos">
        {atual ? <img src={atual} alt="" /> : <span className="wms-cf-stage-empty">sem foto</span>}
        {fotos.length > 0 && <span className="wms-cf-zoom-hint">ampliar ⤢</span>}
      </div>
      {fotos.length > 1 && (
        <div className="wms-cf-thumbs">
          {fotos.map((src, n) => (
            <button
              key={src + n}
              type="button"
              className={`wms-cf-thumb ${n === idx ? "is-active" : ""}`}
              onClick={(e) => { e.stopPropagation(); setIdx(n); }}
              aria-label={`Foto ${n + 1}`}
            >
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <div className="wms-cf-sku wms-mono">{prod?.sku ?? "—"}</div>
      <div className="wms-cf-desc">{prod?.descricao ?? ""}</div>
    </div>
  );
}

export function CrossFila() {
  const qc = useQueryClient();
  const [i, setI] = useState(0);
  const [ampliar, setAmpliar] = useState(false);
  const [filtroOrigem, setFiltroOrigem] =
    useState<FiltroOrigemSugestao>("todas");

  const q = useQuery<{ itens: FilaItem[] }>({
    queryKey: ["wms-cross-fila"],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/fila`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const todosItens = q.data?.itens ?? [];
  const itens = filtrarSugestoesPorOrigem(todosItens, filtroOrigem);
  const indiceAtual = Math.min(i, Math.max(0, itens.length - 1));
  const atual = itens[indiceAtual];
  const totalManuais = todosItens.filter(
    (item) => origemSugestao(item.fonte) === "manual",
  ).length;
  const totalAutomaticas = todosItens.length - totalManuais;

  const decidir = useMutation({
    mutationFn: async (acao: "confirmar" | "bloquear") => {
      if (!atual) return;
      const r = await sisoFetch(`/api/wms/cross/${atual.id}/decidir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: (_d, acao) => {
      toast.success(acao === "confirmar" ? "Confirmado ✓" : "Bloqueado 🚫");
      qc.invalidateQueries({ queryKey: ["wms-cross-fila"] });
      qc.invalidateQueries({ queryKey: ["wms-cross-ficha"] });
      setI((n) => Math.min(n, Math.max(0, itens.length - 2)));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pular = () =>
    setI(Math.min(indiceAtual + 1, Math.max(0, itens.length - 1)));

  // Atalhos: ✓ = → / Enter; ✗ = ←; pular = espaço. Desligados com o zoom aberto.
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if (!atual || decidir.isPending || ampliar) return;
      if (ev.key === "ArrowRight" || ev.key === "Enter") decidir.mutate("confirmar");
      else if (ev.key === "ArrowLeft") decidir.mutate("bloquear");
      else if (ev.key === " ") { ev.preventDefault(); pular(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [atual, decidir.isPending, ampliar]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <div className="wms-exp-empty" style={{ padding: 24 }}>Carregando…</div>;

  const esquerda: LadoComparacao | null = atual
    ? {
        rotulo: "Peça A",
        sku: atual.sku_a,
        descricao: atual.a?.descricao ?? "",
        imagens: imgs(atual.a),
      }
    : null;
  const direita: LadoComparacao | null = atual
    ? {
        rotulo: "Peça B",
        sku: atual.sku_b,
        descricao: atual.b?.descricao ?? "",
        imagens: imgs(atual.b),
      }
    : null;
  const pct = itens.length
    ? Math.round(((indiceAtual + 1) / itens.length) * 100)
    : 0;

  return (
    <div className="wms-cross-fila">
      <div className="wms-vtab" style={{ marginBottom: 12 }}>
        {(
          [
            ["todas", "Todas", todosItens.length],
            ["manual", "Manuais", totalManuais],
            ["automatica", "Automáticas", totalAutomaticas],
          ] as const
        ).map(([valor, label, total]) => (
          <button
            key={valor}
            type="button"
            className={`wms-vtab-btn ${
              filtroOrigem === valor ? "is-active" : ""
            }`}
            onClick={() => {
              setFiltroOrigem(valor);
              setI(0);
            }}
          >
            {label} <span className="wms-vtab-n">{total}</span>
          </button>
        ))}
      </div>

      {itens.length === 0 || !atual ? (
        <div className="wms-exp-empty" style={{ padding: 24 }}>
          {todosItens.length === 0
            ? "Fila vazia — nada pra validar."
            : `Nenhuma sugestão ${
                filtroOrigem === "manual" ? "manual" : "automática"
              } aguardando validação.`}
        </div>
      ) : (
        <>
          <div className="wms-cf-top">
            <span className="wms-cf-count">
              {indiceAtual + 1} / {itens.length}
            </span>
            <div className="wms-cf-progress">
              <i style={{ width: `${pct}%` }} />
            </div>
            <span className="wms-cf-fonte">
              origem:{" "}
              <strong>
                {origemSugestao(atual.fonte) === "manual"
                  ? "manual"
                  : "automática"}
              </strong>
            </span>
          </div>

          {atual.oem_compartilhado &&
            atual.oem_compartilhado.length > 0 && (
              <div className="wms-cf-oem">
                <span className="wms-cf-oem-lb">compartilham OEM:</span>
                {atual.oem_compartilhado.map((o) => (
                  <span key={o} className="wms-chip wms-mono">
                    {o}
                  </span>
                ))}
              </div>
            )}

          <div className="wms-cf-compare">
            <Pane
              key={`a-${atual.a?.sku ?? atual.id}`}
              rotulo="Peça A"
              prod={atual.a}
              onZoom={() => setAmpliar(true)}
            />
            <div className="wms-cf-vs">VS</div>
            <Pane
              key={`b-${atual.b?.sku ?? atual.id}`}
              rotulo="Peça B"
              prod={atual.b}
              onZoom={() => setAmpliar(true)}
            />
          </div>

          <div className="wms-cf-actions">
            <button
              className="wms-btn wms-btn-danger"
              disabled={decidir.isPending}
              onClick={() => decidir.mutate("bloquear")}
            >
              ✗ Não é a mesma <kbd>←</kbd>
            </button>
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() => setAmpliar(true)}
            >
              Ampliar fotos
            </button>
            <button className="wms-btn wms-btn-ghost" onClick={pular}>
              Pular <kbd>espaço</kbd>
            </button>
            <button
              className="wms-btn wms-btn-primary"
              disabled={decidir.isPending}
              onClick={() => decidir.mutate("confirmar")}
            >
              ✓ É a mesma <kbd>→</kbd>
            </button>
          </div>

          {ampliar && esquerda && direita && (
            <ProdutoComparador
              esquerda={esquerda}
              direita={direita}
              onClose={() => setAmpliar(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
