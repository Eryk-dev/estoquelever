"use client";

import type React from "react";
import { Icon } from "@/components/wms/ui/wms-ui";
import {
  getEcommerceAbbr,
  getMarketplaceName,
  formatRelativeTime,
} from "@/lib/domain-helpers";
import { EstoquePorGalpaoBar } from "./estoque-por-galpao-bar";
import { DecisaoLabel } from "./estoque-por-galpao-bar";

interface ItemRow {
  itemId: string;
  produtoId: number;
  sku: string;
  descricao: string;
  quantidadePedida: number;
  imagemUrl?: string | null;
  estoques: Record<
    string,
    {
      saldo: number;
      reservado: number;
      disponivel: number;
      localizacao?: string;
    }
  >;
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
    sugestao: "propria" | "transferencia" | "oc";
    decisaoFinal?: "propria" | "transferencia" | "oc";
    compraEstoqueLancadoAlerta?: boolean;
    encaminhadoDe?: string | null;
    criadoEm: string;
    itens: ItemRow[];
  };
  readOnly?: boolean;
  modo?: "completo" | "colapsado";
  onClick?: () => void;
  acoes?: React.ReactNode;
}

function galpaoChipClass(filial: string): string {
  const lower = filial.toLowerCase();
  if (lower === "cwb" || lower === "sp") {
    return `wms-pcard-chip is-galpao is-${lower}`;
  }
  return "wms-pcard-chip is-galpao";
}

function PedidoCardWms({
  pedido,
  readOnly: _readOnly,
  modo = "completo",
  onClick,
  acoes,
}: PedidoCardWmsProps) {
  const {
    numero,
    idPedidoEcommerce,
    nomeEcommerce,
    cliente,
    filialOrigem,
    filialFulfillment,
    sugestao,
    decisaoFinal,
    compraEstoqueLancadoAlerta,
    encaminhadoDe,
    criadoEm,
    itens,
  } = pedido;

  const mostrarSeta = filialFulfillment && filialFulfillment !== filialOrigem;
  const itensExibidos = modo === "colapsado" ? itens.slice(0, 2) : itens;
  const itensExtras = itens.length - 2;

  return (
    <article
      className="wms-pcard"
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : "default" }}
    >
      {compraEstoqueLancadoAlerta && (
        <div className="wms-pcard-banner-alert">
          <Icon name="alert" size={12} />
          Pedido cancelado após separação — requer estorno manual
        </div>
      )}

      <header className="wms-pcard-h">
        <div className="wms-pcard-h-left">
          <span className="wms-pcard-num">#{numero}</span>
          <span className="wms-pcard-cliente">{cliente.nome}</span>
          <span className="wms-pcard-chip">
            {getEcommerceAbbr(nomeEcommerce)}
          </span>
          <span className={galpaoChipClass(filialOrigem)}>
            {filialOrigem}
            {mostrarSeta && (
              <>
                <span className="wms-pcard-chip-arrow">←</span>
                <span>{filialFulfillment}</span>
              </>
            )}
          </span>
          <DecisaoLabel
            decisao={decisaoFinal ?? sugestao}
            galpaoOrigem={filialOrigem}
            galpaoFulfillment={filialFulfillment ?? null}
            compact
          />
          {encaminhadoDe && (
            <span className="wms-pcard-meta">
              Encaminhado de {encaminhadoDe}
            </span>
          )}
        </div>
        {acoes && <div className="wms-pcard-actions">{acoes}</div>}
      </header>

      <div className="wms-pcard-meta">
        EC #{idPedidoEcommerce} · {getMarketplaceName(nomeEcommerce)} ·{" "}
        {formatRelativeTime(criadoEm)}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {itensExibidos.map((item) => (
          <div className="wms-pcard-item" key={item.itemId}>
            {item.imagemUrl ? (
              <img
                src={item.imagemUrl}
                loading="lazy"
                className="wms-thumb wms-thumb-sm"
                alt=""
              />
            ) : (
              <div
                className="wms-thumb wms-thumb-sm"
                style={{ background: "var(--wms-c-faint)" }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div className="wms-pcard-item-sku">
                <span>{item.sku}</span>
                {item.fornecedorOC && (
                  <span
                    className="wms-pcard-chip"
                    style={{ fontSize: "9.5px" }}
                  >
                    OC · {item.fornecedorOC}
                  </span>
                )}
              </div>
              <div className="wms-pcard-item-desc">{item.descricao}</div>
              <div style={{ marginTop: "4px" }}>
                <EstoquePorGalpaoBar
                  estoques={item.estoques}
                  quantidadePedida={item.quantidadePedida}
                  galpaoOrigem={filialOrigem}
                  galpaoDecisaoFinal={filialFulfillment ?? null}
                />
              </div>
            </div>
            <div className="wms-pcard-item-qty">{item.quantidadePedida}</div>
          </div>
        ))}
        {modo === "colapsado" && itens.length > 2 && (
          <div
            className="wms-td-mute"
            style={{
              fontSize: "11px",
              textAlign: "center",
              paddingTop: "4px",
            }}
          >
            + {itensExtras} ite{itensExtras === 1 ? "m" : "ns"}
          </div>
        )}
      </div>
    </article>
  );
}

export { PedidoCardWms };
export type { PedidoCardWmsProps, ItemRow as ItemRowWms };
