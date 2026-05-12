"use client";

import { formatRelativeTime } from "@/lib/domain-helpers";

type EventoTone = "ok" | "info" | "warn" | "danger" | "mute";

interface HistoricoEvento {
  id: string;
  evento: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  detalhes: Record<string, unknown> | null;
  criado_em: string;
}

interface TimelinePedidoProps {
  eventos: HistoricoEvento[];
}

const EVENTO_LABELS: Record<string, string> = {
  criado: "Pedido criado",
  webhook_recebido: "Webhook recebido",
  aprovado_auto: "Aprovado automaticamente",
  aprovado_manual: "Aprovado manualmente",
  reservado: "Estoque reservado",
  aguardando_compra: "Aguardando compra",
  compra_realizada: "Compra realizada",
  compra_recebida: "Compra recebida",
  nf_emitida: "NF emitida",
  separacao_iniciada: "Separação iniciada",
  separacao_concluida: "Separação concluída",
  embalado: "Embalagem concluída",
  etiqueta_impressa: "Etiqueta impressa",
  expedido: "Expedido",
  encaminhado: "Encaminhado para outro galpão",
  cancelado: "Pedido cancelado",
  erro: "Erro no processamento",
  observacao: "Observação adicionada",
};

const EVENTO_TONE: Record<string, EventoTone> = {
  cancelado: "danger",
  erro: "danger",
  aguardando_compra: "warn",
  encaminhado: "warn",
  aprovado_auto: "ok",
  aprovado_manual: "ok",
  expedido: "ok",
  etiqueta_impressa: "ok",
  separacao_concluida: "ok",
  embalado: "ok",
  reservado: "info",
  compra_realizada: "info",
  compra_recebida: "info",
  nf_emitida: "info",
  separacao_iniciada: "info",
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function TimelinePedido({ eventos }: TimelinePedidoProps) {
  if (eventos.length === 0) {
    return (
      <div
        className="wms-td-mute"
        style={{ padding: "16px", textAlign: "center", fontSize: "12px" }}
      >
        Nenhum evento ainda.
      </div>
    );
  }

  return (
    <ol className="wms-tline">
      {eventos.map((evento) => {
        const tone: EventoTone = EVENTO_TONE[evento.evento] ?? "mute";
        const label = EVENTO_LABELS[evento.evento] ?? evento.evento;
        const hasDetalhes =
          evento.detalhes &&
          typeof evento.detalhes === "object" &&
          Object.keys(evento.detalhes).length > 0;
        const detalhesStr = hasDetalhes
          ? truncate(JSON.stringify(evento.detalhes), 200)
          : null;

        return (
          <li key={evento.id} className={`wms-tline-item is-${tone}`}>
            <div className="wms-tline-h">
              {label}
              <span className="wms-tline-when">
                · {formatRelativeTime(evento.criado_em)}
              </span>
            </div>
            {evento.usuario_nome && (
              <div className="wms-tline-detail">por {evento.usuario_nome}</div>
            )}
            {detalhesStr && (
              <div className="wms-tline-detail">{detalhesStr}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export { TimelinePedido };
export type { TimelinePedidoProps, HistoricoEvento };
