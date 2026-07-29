"use client";

import { useState } from "react";
import { Icon, fmtDateTime } from "@/components/wms/ui/wms-ui";
import { DecisaoLabel } from "./estoque-por-galpao-bar";
import {
  ItemRowV2,
  getTransferTarget,
  galpaoChipClass,
  type ItemRowWms,
  type DecisaoWms,
} from "./pedido-card-wms";
import {
  getEcommerceAbbr,
  getMarketplaceName,
  formatRelativeTime,
} from "@/lib/domain-helpers";

interface PedidoConcluidoData {
  id: string;
  numero: string;
  idPedidoEcommerce?: string;
  nomeEcommerce: string;
  cliente: { nome: string };
  filialOrigem: string;
  filialFulfillment?: string | null;
  sugestao: DecisaoWms;
  decisaoFinal?: DecisaoWms | null;
  tipoResolucao?: "auto" | "manual" | null;
  operador?: string | null;
  processadoEm?: string | null;
  criadoEm: string;
  marcadores?: string[];
  erro?: string | null;
  empresaOrigemNome?: string | null;
  encaminhadoDe?: string | null;
  itens: ItemRowWms[];
  sugestaoMotivo?: string | null;
}

interface PedidoCardConcluidoWmsProps {
  pedido: PedidoConcluidoData;
  onClick?: () => void;
  /** Ocultar o sufixo "Manual (operador)" — usado na aba Auto */
  ocultarOperador?: boolean;
}

function PedidoCardConcluidoWms({
  pedido,
  onClick,
  ocultarOperador = false,
}: PedidoCardConcluidoWmsProps) {
  const [expanded, setExpanded] = useState(false);
  const decisao: DecisaoWms = pedido.decisaoFinal ?? pedido.sugestao;
  const isAuto = pedido.tipoResolucao === "auto";
  const processadoIso = pedido.processadoEm ?? pedido.criadoEm;

  const galpaoFulfillment =
    decisao === "transferencia"
      ? getTransferTarget(pedido.itens, pedido.filialOrigem)
      : decisao === "propria"
        ? pedido.filialOrigem
        : null;

  function handleRowClick(e: React.MouseEvent) {
    // Se tem onClick (navegação), Shift/Cmd/Ctrl-click vai pro detalhe;
    // click simples expande/colapsa inline.
    if (onClick && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.stopPropagation();
      onClick();
      return;
    }
    setExpanded((v) => !v);
  }

  function handleOpenDetail(e: React.MouseEvent) {
    e.stopPropagation();
    onClick?.();
  }

  return (
    <article
      className={`wms-pcard-wrap wms-pcard-compact${
        expanded ? " is-expanded" : ""
      }`}
      aria-label={`Pedido concluído #${pedido.numero}`}
    >
      <div className={`wms-pcard-strip is-${decisao}`} aria-hidden />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <button
          type="button"
          className="wms-pcard-compact-row"
          onClick={handleRowClick}
          aria-expanded={expanded}
        >
          <span className="wms-pcard-compact-num">#{pedido.numero}</span>

          <span
            className="wms-pcard-compact-cliente"
            title={pedido.cliente.nome}
          >
            {pedido.cliente.nome}
          </span>

          <span className="wms-pcard-compact-chips">
            {pedido.empresaOrigemNome && (
              <span className="wms-pcard-chip" title="Empresa de origem">
                {pedido.empresaOrigemNome}
              </span>
            )}
            <span
              className="wms-pcard-chip"
              title={getMarketplaceName(pedido.nomeEcommerce)}
            >
              {getEcommerceAbbr(pedido.nomeEcommerce)}
            </span>
            <span className={galpaoChipClass(pedido.filialOrigem)}>
              {pedido.filialOrigem}
            </span>
          </span>

          <DecisaoLabel
            decisao={decisao}
            galpaoOrigem={pedido.filialOrigem}
            galpaoFulfillment={galpaoFulfillment}
            compact
            plain
          />

          <span
            style={{
              color: "var(--wms-c-ok)",
              display: "inline-flex",
              alignItems: "center",
              flexShrink: 0,
            }}
            aria-label="Concluído"
            title="Concluído"
          >
            <Icon name="check" size={12} />
          </span>

          {!ocultarOperador && (
            <span
              className={`wms-pcard-compact-resolutor${
                isAuto ? " is-auto" : ""
              }`}
            >
              {isAuto ? "Auto" : pedido.operador ? `Manual · ${pedido.operador}` : "Manual"}
            </span>
          )}

          <span
            className="wms-pcard-compact-time"
            title={`Criado em ${fmtDateTime(pedido.criadoEm)}${
              pedido.processadoEm
                ? ` · Processado ${formatRelativeTime(processadoIso)}`
                : ""
            }`}
          >
            Criado {fmtDateTime(pedido.criadoEm)}
          </span>

          <span
            className={`wms-pcard-compact-chev${expanded ? " is-open" : ""}`}
            aria-hidden
          >
            <Icon name="chevron-d" size={11} />
          </span>
        </button>

        {expanded && (
          <div className="wms-pcard-compact-expand">
            {pedido.sugestaoMotivo && (
              <div
                className="wms-pcard-meta"
                style={{ marginBottom: 6 }}
              >
                {pedido.sugestaoMotivo}
              </div>
            )}

            <div className="wms-pcard-items-v2">
              {pedido.itens.map((it) => (
                <ItemRowV2
                  key={it.itemId}
                  item={it}
                  decisao={decisao}
                  filialOrigem={pedido.filialOrigem}
                  galpaoFulfillment={galpaoFulfillment}
                  isOC={decisao === "oc"}
                />
              ))}
            </div>

            {(pedido.marcadores?.length || pedido.erro || onClick) && (
              <div
                style={{
                  borderTop: "1px solid var(--wms-c-border)",
                  paddingTop: 8,
                  marginTop: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {pedido.marcadores?.map((m) => (
                  <span key={m} className="wms-pcard-chip">
                    {m}
                  </span>
                ))}
                {pedido.erro && (
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--wms-c-danger)",
                      fontWeight: 500,
                    }}
                  >
                    {pedido.erro}
                  </span>
                )}
                {onClick && (
                  <button
                    type="button"
                    className="wms-btn wms-btn-ghost wms-btn-sm"
                    style={{ marginLeft: "auto" }}
                    onClick={handleOpenDetail}
                  >
                    Abrir detalhe
                    <Icon name="arrow-right" size={10} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export { PedidoCardConcluidoWms };
export type { PedidoCardConcluidoWmsProps, PedidoConcluidoData };
