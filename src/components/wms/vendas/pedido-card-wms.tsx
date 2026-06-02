"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/wms/ui/wms-ui";
import { CrossPopoverButton } from "@/components/wms/cross/cross-popover-button";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import {
  getEcommerceAbbr,
  getMarketplaceName,
  formatRelativeTime,
} from "@/lib/domain-helpers";
import { EstoquePorGalpaoBar, DecisaoLabel } from "./estoque-por-galpao-bar";

// ── Tipos ─────────────────────────────────────────────────────────────

type Decisao = "propria" | "transferencia" | "oc";

interface ItemEstoque {
  saldo: number;
  reservado: number;
  disponivel: number;
  localizacao?: string;
}

interface ItemRow {
  itemId: string;
  produtoId: number;
  sku: string;
  descricao: string;
  quantidadePedida: number;
  imagemUrl?: string | null;
  imagens?: string[];
  estoques: Record<string, ItemEstoque>;
  fornecedorOC?: string | null;
}

interface PedidoCardWmsProps {
  pedido: {
    id: string;
    numero: string;
    idPedidoEcommerce: string;
    nomeEcommerce: string;
    cliente: { nome: string; cpfCnpj?: string };
    filialOrigem: string;
    filialFulfillment?: string | null;
    sugestao: Decisao;
    decisaoFinal?: Decisao;
    compraEstoqueLancadoAlerta?: boolean;
    encaminhadoDe?: string | null;
    empresaOrigemNome?: string | null;
    criadoEm: string;
    itens: ItemRow[];
  };
  onClick?: () => void;
  /**
   * Modo interativo (aba pendente): renderiza footer com dropdown da decisão +
   * botão "Aprovar →". Quando undefined, o card é só leitura.
   */
  interactive?: {
    onApprove: (decisao: Decisao) => Promise<void> | void;
    loading?: boolean;
  };
}

// ── Helpers de domínio ────────────────────────────────────────────────

function galpaoAtendeTudo(itens: ItemRow[], galpao: string): boolean {
  return itens.every((it) => {
    const e = it.estoques[galpao];
    if (!e) return false;
    return e.disponivel >= it.quantidadePedida;
  });
}

function getAllGalpoes(itens: ItemRow[]): string[] {
  const set = new Set<string>();
  for (const it of itens) {
    for (const g of Object.keys(it.estoques)) set.add(g);
  }
  return [...set].sort();
}

function getTransferTarget(itens: ItemRow[], filialOrigem: string): string {
  const galpoes = getAllGalpoes(itens);
  // Primeira tentativa: galpão que cobre tudo
  for (const g of galpoes) {
    if (g !== filialOrigem && galpaoAtendeTudo(itens, g)) return g;
  }
  // Fallback: o que tem mais cobertura
  let best = "";
  let bestCount = 0;
  for (const g of galpoes) {
    if (g === filialOrigem) continue;
    const count = itens.filter((it) => {
      const e = it.estoques[g];
      return e && e.disponivel >= it.quantidadePedida;
    }).length;
    if (count > bestCount) {
      best = g;
      bestCount = count;
    }
  }
  return best || galpoes.find((g) => g !== filialOrigem) || "?";
}

function decisaoIsAvailable(
  decisao: Decisao,
  itens: ItemRow[],
  filialOrigem: string,
): boolean {
  if (decisao === "propria") return galpaoAtendeTudo(itens, filialOrigem);
  if (decisao === "transferencia") {
    for (const g of getAllGalpoes(itens)) {
      if (g !== filialOrigem && galpaoAtendeTudo(itens, g)) return true;
    }
    return false;
  }
  // OC: só disponível quando NENHUM galpão (incluindo origem) cobre tudo sozinho.
  // Decisão 1 (28/05): se snapshot tem cobertura, força Própria/Transferência (que cria reserva).
  for (const g of getAllGalpoes(itens)) {
    if (galpaoAtendeTudo(itens, g)) return false;
  }
  return true;
}

function decisaoLabel(
  decisao: Decisao,
  filialOrigem: string,
  itens: ItemRow[],
): string {
  if (decisao === "propria") return `Sai daqui (${filialOrigem})`;
  if (decisao === "transferencia") {
    return `${getTransferTarget(itens, filialOrigem)} → ${filialOrigem}`;
  }
  return "Ordem de Compra";
}

function getRelevantLocation(
  item: ItemRow,
  decisao: Decisao,
  filialOrigem: string,
): { galpao: string; loc: string } | null {
  if (decisao === "propria") {
    const loc = item.estoques[filialOrigem]?.localizacao;
    if (loc) return { galpao: filialOrigem, loc };
    return null;
  }
  if (decisao === "transferencia") {
    const target = getTransferTarget([item], filialOrigem);
    const loc = item.estoques[target]?.localizacao;
    if (loc) return { galpao: target, loc };
    return null;
  }
  return null;
}

function galpaoChipClass(filial: string): string {
  const lower = filial.toLowerCase();
  if (lower === "cwb" || lower === "sp") {
    return `wms-pcard-chip is-galpao is-${lower}`;
  }
  return "wms-pcard-chip is-galpao";
}

// ── Dropdown de decisão ───────────────────────────────────────────────

function DecisaoDropdown({
  itens,
  filialOrigem,
  current,
  onSelect,
  onClose,
}: {
  itens: ItemRow[];
  filialOrigem: string;
  current: Decisao;
  onSelect: (d: Decisao) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const alternativas: Decisao[] = (["propria", "transferencia", "oc"] as Decisao[]).filter(
    (d) => d !== current,
  );

  return (
    <div ref={ref} className="wms-dec-dropdown" role="listbox">
      {alternativas.map((d) => {
        const available = decisaoIsAvailable(d, itens, filialOrigem);
        return (
          <button
            key={d}
            type="button"
            role="option"
            aria-selected={false}
            disabled={!available}
            onClick={(e) => {
              e.stopPropagation();
              if (!available) return;
              onSelect(d);
              onClose();
            }}
            className="wms-dec-dropdown-item"
          >
            <span className={`wms-dec-dropdown-item-dot is-${d}`} aria-hidden />
            <span>{decisaoLabel(d, filialOrigem, itens)}</span>
            {!available && (
              <span className="wms-dec-dropdown-item-sub">sem estoque</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Item row (linha de produto rica) ──────────────────────────────────

function ItemRowV2({
  item,
  decisao,
  filialOrigem,
  galpaoFulfillment,
  isOC,
}: {
  item: ItemRow;
  decisao: Decisao;
  filialOrigem: string;
  galpaoFulfillment: string | null;
  isOC: boolean;
}) {
  const loc = getRelevantLocation(item, decisao, filialOrigem);
  const semEstoqueLugar = !Object.values(item.estoques).some(
    (e) => e.disponivel >= item.quantidadePedida,
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const fotos =
    item.imagens && item.imagens.length > 0
      ? item.imagens
      : item.imagemUrl
        ? [item.imagemUrl]
        : [];

  return (
    <>
    <div className="wms-pcard-item-v2">
      <div className="wms-pcard-thumb">
        {item.imagemUrl ? (
          <img
            src={item.imagemUrl}
            loading="lazy"
            alt=""
            className="wms-pcard-thumb-img wms-thumb-click"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxOpen(true);
            }}
          />
        ) : (
          <div className="wms-pcard-thumb-placeholder">
            <Icon name="box" size={18} />
          </div>
        )}
        <span className="wms-pcard-thumb-qty" aria-label="quantidade">
          {item.quantidadePedida}
        </span>
      </div>

      <div className="wms-pcard-item-v2-body">
        <div className="wms-pcard-item-v2-head">
          <span className="wms-pcard-sku-chip" title={`SKU: ${item.sku}`}>
            {item.sku}
          </span>
          <CrossPopoverButton sku={item.sku} variant="icon" />
          {isOC && item.fornecedorOC && (
            <span
              className="wms-pcard-chip"
              title={`Fornecedor sugerido: ${item.fornecedorOC}`}
            >
              {item.fornecedorOC}
            </span>
          )}
        </div>

        <div
          className="wms-pcard-item-v2-desc"
          title={item.descricao}
        >
          {item.descricao}
        </div>

        <div className="wms-pcard-item-v2-stk">
          {isOC || semEstoqueLugar ? (
            Object.entries(item.estoques)
              .filter(([, e]) => e.localizacao)
              .map(([g, e]) => (
                <span key={g} className="wms-pcard-loc" title="Localização">
                  <Icon name="pin" size={9} />
                  {g}: {e.localizacao}
                </span>
              ))
          ) : loc ? (
            <span className="wms-pcard-loc" title="Localização">
              <Icon name="pin" size={9} />
              {loc.galpao}: {loc.loc}
            </span>
          ) : (
            <span className="wms-pcard-loc-empty">sem local</span>
          )}

          <span className="wms-pcard-stk-sep" aria-hidden />

          <EstoquePorGalpaoBar
            estoques={item.estoques}
            quantidadePedida={item.quantidadePedida}
            galpaoOrigem={filialOrigem}
            galpaoDecisaoFinal={galpaoFulfillment}
          />
        </div>
      </div>
    </div>
    {lightboxOpen && fotos.length > 0 && (
      <ProdutoLightbox
        imagens={fotos}
        sku={item.sku}
        descricao={item.descricao}
        onClose={() => setLightboxOpen(false)}
      />
    )}
    </>
  );
}

// ── Card principal ────────────────────────────────────────────────────

function PedidoCardWms({ pedido, onClick, interactive }: PedidoCardWmsProps) {
  const {
    numero,
    idPedidoEcommerce,
    nomeEcommerce,
    cliente,
    filialOrigem,
    sugestao,
    decisaoFinal,
    compraEstoqueLancadoAlerta,
    encaminhadoDe,
    empresaOrigemNome,
    criadoEm,
    itens,
  } = pedido;

  // [Fix-D #1.3 / sugestão viva] Sem recompute client-side. O GET /api/wms/pedidos
  // já recomputa a sugestão contra o estoque vivo pra pedidos em decisão
  // (pendente/erro), então `sugestao` aqui já chega atualizado — um pedido que
  // ganhou saldo depois do webhook vem como propria/transferencia, não OC.
  // Recomputar de novo no cliente só traria o flicker que removemos. Server wins.
  const [decisao, setDecisao] = useState<Decisao>(decisaoFinal ?? sugestao);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Galpão alvo de transferência (pra mostrar nas labels)
  const galpaoFulfillment =
    decisao === "transferencia"
      ? getTransferTarget(itens, filialOrigem)
      : decisao === "propria"
        ? filialOrigem
        : null;

  function handleApprove(e: React.MouseEvent) {
    e.stopPropagation();
    if (!interactive) return;
    void interactive.onApprove(decisao);
  }

  return (
    <article
      className={`wms-pcard-wrap${onClick ? " is-clickable" : ""}`}
      onClick={onClick}
      aria-label={`Pedido #${numero}`}
    >
      <div
        className={`wms-pcard-strip is-${decisao}`}
        aria-hidden
      />

      <div className="wms-pcard-body">
        {compraEstoqueLancadoAlerta && (
          <div className="wms-pcard-banner-alert">
            <Icon name="alert" size={12} />
            Pedido cancelado após separação — requer estorno manual
          </div>
        )}

        <header className="wms-pcard-h">
          <div className="wms-pcard-h-left">
            <span className="wms-pcard-num">#{numero}</span>
            {idPedidoEcommerce && (
              <span
                className="wms-pcard-meta"
                style={{ fontSize: 11, fontFamily: "var(--wms-font-mono)" }}
                title="ID externo (marketplace)"
              >
                EC {idPedidoEcommerce}
              </span>
            )}
            <span className="wms-pcard-cliente" title={cliente.nome}>
              {cliente.nome}
            </span>
          </div>
          <div className="wms-pcard-h-right">
            {empresaOrigemNome && (
              <span className="wms-pcard-chip" title="Empresa de origem">
                {empresaOrigemNome}
              </span>
            )}
            <span
              className="wms-pcard-chip"
              title={getMarketplaceName(nomeEcommerce)}
            >
              {getEcommerceAbbr(nomeEcommerce)}
            </span>
            <span className={galpaoChipClass(filialOrigem)}>
              {filialOrigem}
            </span>
            {encaminhadoDe && (
              <span
                className="wms-pcard-chip"
                style={{
                  background: "var(--wms-c-info-bg)",
                  color: "var(--wms-c-info)",
                  borderColor: "var(--wms-c-info-bd)",
                }}
                title={`Encaminhado de ${encaminhadoDe}`}
              >
                <Icon name="arrows" size={9} />
                Enc. {encaminhadoDe}
              </span>
            )}
          </div>
        </header>

        <div className="wms-pcard-meta-row">
          <span>{formatRelativeTime(criadoEm)}</span>
        </div>

        <div className="wms-pcard-items-v2">
          {itens.map((it) => (
            <ItemRowV2
              key={it.itemId}
              item={it}
              decisao={decisao}
              filialOrigem={filialOrigem}
              galpaoFulfillment={galpaoFulfillment}
              isOC={decisao === "oc"}
            />
          ))}
        </div>

        {interactive && (
          <div className="wms-pcard-footer" onClick={(e) => e.stopPropagation()}>
            <div className="wms-pcard-footer-left">
              <DecisaoLabel
                decisao={decisao}
                galpaoOrigem={filialOrigem}
                galpaoFulfillment={galpaoFulfillment}
                plain
              />
              <button
                type="button"
                aria-label="Mudar decisão"
                aria-expanded={dropdownOpen}
                className={`wms-dec-toggle${dropdownOpen ? " is-open" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setDropdownOpen((v) => !v);
                }}
              >
                <Icon name="chevron-d" size={11} />
              </button>
              {dropdownOpen && (
                <DecisaoDropdown
                  itens={itens}
                  filialOrigem={filialOrigem}
                  current={decisao}
                  onSelect={(d) => setDecisao(d)}
                  onClose={() => setDropdownOpen(false)}
                />
              )}
            </div>
            <div className="wms-pcard-footer-right">
              <button
                type="button"
                className="wms-btn-approve"
                onClick={handleApprove}
                disabled={interactive.loading}
                aria-busy={interactive.loading}
              >
                {interactive.loading ? (
                  <>
                    <Icon name="rotate" size={12} />
                    Aprovando
                  </>
                ) : (
                  <>
                    Aprovar
                    <Icon name="arrow-right" size={12} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

export { PedidoCardWms, ItemRowV2, getTransferTarget, galpaoChipClass };
export type { PedidoCardWmsProps, ItemRow as ItemRowWms, Decisao as DecisaoWms };
