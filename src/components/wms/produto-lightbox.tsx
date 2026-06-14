"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/wms/ui/wms-ui";

/**
 * Carrossel/lightbox de imagens do produto.
 *
 * Renderiza um overlay full-screen com a imagem em tamanho grande,
 * tiras de thumbnails embaixo, e controles prev/next quando há mais
 * de uma foto. Fecha com ESC ou clique fora. Setas do teclado navegam.
 */
export function ProdutoLightbox({
  imagens,
  initialIndex = 0,
  sku,
  descricao,
  onClose,
}: {
  imagens: string[];
  initialIndex?: number;
  sku?: string;
  descricao?: string;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(
    Math.min(Math.max(initialIndex, 0), Math.max(imagens.length - 1, 0)),
  );

  const prev = useCallback(
    () => setIdx((i) => (i - 1 + imagens.length) % imagens.length),
    [imagens.length],
  );
  const next = useCallback(
    () => setIdx((i) => (i + 1) % imagens.length),
    [imagens.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && imagens.length > 1) prev();
      else if (e.key === "ArrowRight" && imagens.length > 1) next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next, imagens.length]);

  if (imagens.length === 0) return null;

  return (
    <div
      className="wms-lb-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="wms-lb-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Fechar"
      >
        <Icon name="x" size={18} />
      </button>

      <div className="wms-lb-meta">
        {sku && <span className="wms-mono wms-lb-sku">{sku}</span>}
        {descricao && <span className="wms-lb-desc">{descricao}</span>}
        {imagens.length > 1 && (
          <span className="wms-lb-counter">
            {idx + 1} / {imagens.length}
          </span>
        )}
      </div>

      {/* Stage NÃO stop-propaga — clicar no espaço vazio em volta da foto
          fecha o lightbox (UX padrão de visualizador). Só a imagem e os
          botões de navegação param a propagação. */}
      <div className="wms-lb-stage">
        {imagens.length > 1 && (
          <button
            type="button"
            className="wms-lb-nav wms-lb-nav-prev"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            aria-label="Anterior"
          >
            <Icon name="chevron-l" size={22} />
          </button>
        )}

        <img
          key={imagens[idx]}
          src={imagens[idx]}
          alt={descricao ?? ""}
          className="wms-lb-img"
          onClick={(e) => e.stopPropagation()}
        />

        {imagens.length > 1 && (
          <button
            type="button"
            className="wms-lb-nav wms-lb-nav-next"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            aria-label="Próxima"
          >
            <Icon name="chevron-r" size={22} />
          </button>
        )}
      </div>

      {imagens.length > 1 && (
        <div
          className="wms-lb-strip"
          onClick={(e) => e.stopPropagation()}
        >
          {imagens.map((src, i) => (
            <button
              key={src + i}
              type="button"
              className={`wms-lb-thumb ${i === idx ? "is-active" : ""}`}
              onClick={() => setIdx(i)}
              aria-label={`Foto ${i + 1}`}
            >
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────

export interface LadoComparacao {
  rotulo: string;
  sku?: string;
  descricao?: string;
  imagens: string[];
}

/** Um painel do comparador: foto grande + prev/next + strip, índice próprio. */
function ComparePane({ lado }: { lado: LadoComparacao }) {
  const { imagens, sku, descricao, rotulo } = lado;
  const [idx, setIdx] = useState(0);
  const prev = () => setIdx((i) => (i - 1 + imagens.length) % imagens.length);
  const next = () => setIdx((i) => (i + 1) % imagens.length);

  return (
    <div className="wms-lb-pane" onClick={(e) => e.stopPropagation()}>
      <div className="wms-lb-pane-hd">
        <span className="wms-lb-pane-rotulo">{rotulo}</span>
        {sku && <span className="wms-lb-pane-sku">{sku}</span>}
        {descricao && <span className="wms-lb-pane-desc">{descricao}</span>}
        <span className="wms-lb-counter">
          {imagens.length > 0 ? `${idx + 1} / ${imagens.length}` : "sem fotos"}
        </span>
      </div>

      <div className="wms-lb-stage">
        {imagens.length > 1 && (
          <button
            type="button"
            className="wms-lb-nav wms-lb-nav-prev"
            onClick={prev}
            aria-label="Anterior"
          >
            <Icon name="chevron-l" size={20} />
          </button>
        )}
        {imagens.length > 0 ? (
          <img key={imagens[idx]} src={imagens[idx]} alt={descricao ?? ""} className="wms-lb-img" />
        ) : (
          <div className="wms-lb-empty">Sem fotos</div>
        )}
        {imagens.length > 1 && (
          <button
            type="button"
            className="wms-lb-nav wms-lb-nav-next"
            onClick={next}
            aria-label="Próxima"
          >
            <Icon name="chevron-r" size={20} />
          </button>
        )}
      </div>

      {imagens.length > 1 && (
        <div className="wms-lb-strip">
          {imagens.map((src, i) => (
            <button
              key={src + i}
              type="button"
              className={`wms-lb-thumb ${i === idx ? "is-active" : ""}`}
              onClick={() => setIdx(i)}
              aria-label={`Foto ${i + 1}`}
            >
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Comparador lado a lado de dois produtos. Cada painel tem seu próprio
 * carrossel (avança/retrocede individualmente). ESC ou clique fora fecha.
 */
export function ProdutoComparador({
  esquerda,
  direita,
  onClose,
}: {
  esquerda: LadoComparacao;
  direita: LadoComparacao;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="wms-lb-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <button
        type="button"
        className="wms-lb-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Fechar"
      >
        <Icon name="x" size={18} />
      </button>

      <div className="wms-lb-split">
        <ComparePane lado={esquerda} />
        <ComparePane lado={direita} />
      </div>
    </div>
  );
}
