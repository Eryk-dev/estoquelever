/**
 * ml-notifications — processa as notificações (webhook) do Mercado Livre.
 *
 * Promoção de separação futura em TEMPO REAL: quando o ML libera a etiqueta de
 * uma venda buffered (substatus deixa de ser `buffered`), ele empurra uma
 * notificação no tópico `shipments`. Aqui a gente casa o shipment → pedido
 * (via `siso_pedidos.ml_shipment_id`, persistido no enrich de SLA) e promove na
 * hora — emite NF + agrupamento igual ao fluxo normal.
 *
 * É o caminho RÁPIDO. O sweep de polling (`promoverFuturasLiberadas`, cron 30min)
 * continua de rede de segurança: notificação do ML não é 100% confiável
 * (atrasa/perde), então nunca dependemos só dela. Se a notificação chegar antes
 * do `ml_shipment_id` ser persistido (enrich é fire-and-forget), não casa e o
 * polling pega depois.
 *
 * Idempotente: o filtro `separacao_futura=true` já exclui o que foi promovido —
 * notificação repetida vira no-op. Config do callback/tópicos é manual no
 * DevCenter do ML (app ESTOQUE LEVER).
 */

import { createServiceClient } from "./supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  getMlShipmentStatusById,
} from "./ml-api";
import { classificarPromocaoFutura } from "./wms/separacao-futura";
import { promoverPedidoFutura } from "./webhook-processor-wms";
import { logger } from "./logger";

const LOG_SOURCE = "ml-notifications";
const TOPIC_SHIPMENTS = "shipments";

export interface MlNotification {
  resource?: string | null;
  topic?: string | null;
  user_id?: number | string | null;
  application_id?: number | string | null;
}

export type MlNotifReason =
  | "ignored_topic"
  | "no_shipment_id"
  | "pedido_nao_encontrado"
  | "sem_conexao_ml"
  | "mantido"
  | "ignorado"
  | "promovido"
  | "erro";

export interface MlNotifResult {
  handled: boolean;
  reason: MlNotifReason;
  pedidoId?: string;
}

/** Extrai o shipment_id de um resource tipo "/shipments/123" (puro, testável). */
export function parseShipmentIdFromResource(
  resource: string | null | undefined,
): string | null {
  if (!resource) return null;
  const m = /\/shipments\/(\d+)/.exec(resource);
  return m ? m[1] : null;
}

/**
 * Processa uma notificação do ML. Só o tópico `shipments` aciona promoção;
 * qualquer outro é ignorado de barato. Retorna o resultado pra observabilidade.
 */
export async function processMlNotification(
  notif: MlNotification,
): Promise<MlNotifResult> {
  if (notif.topic !== TOPIC_SHIPMENTS) {
    return { handled: false, reason: "ignored_topic" };
  }

  const shipmentId = parseShipmentIdFromResource(notif.resource);
  if (!shipmentId) return { handled: false, reason: "no_shipment_id" };

  const sb = createServiceClient();

  // Casa shipment → futura VIVA. Mesmos filtros do sweep de promoção:
  //  - separacao_futura=true  → ainda na pista futura (exclui já-promovido)
  //  - status != cancelado
  //  - decisao_final != null  → pula futura aguardando aprovação (troca pendente);
  //    promover geraria NF de venda não-aprovada.
  // Sem match: a notificação não é de uma futura nossa (ou o shipment_id ainda
  // não foi persistido) → ignora; o polling cobre.
  const { data: pedido } = await sb
    .from("siso_pedidos")
    .select("id, decisao_final, empresa_origem_id, separacao_galpao_id")
    .eq("ml_shipment_id", shipmentId)
    .eq("separacao_futura", true)
    .neq("status", "cancelado")
    .not("decisao_final", "is", null)
    .maybeSingle();

  if (!pedido) return { handled: false, reason: "pedido_nao_encontrado" };
  if (!pedido.empresa_origem_id) return { handled: false, reason: "sem_conexao_ml" };

  const connId = await getActiveMlConnectionForEmpresa(pedido.empresa_origem_id);
  if (!connId) return { handled: false, reason: "sem_conexao_ml" };

  // Lê o estado ATUAL no ML (a notificação só diz "mudou"). substatus != buffered
  // + shipment ativo → promove; buffered/cancelado/sem leitura → mantém.
  const st = await getMlShipmentStatusById(connId, shipmentId);
  const acao = classificarPromocaoFutura(st?.substatus, st?.status);

  if (acao !== "promover") {
    return {
      handled: true,
      reason: acao === "manter" ? "mantido" : "ignorado",
      pedidoId: pedido.id,
    };
  }

  // Nome do galpão → filial_execucao do job lancar_estoque (igual ao sweep).
  let galpaoNome: string | null = null;
  if (pedido.separacao_galpao_id) {
    const { data: g } = await sb
      .from("siso_galpoes")
      .select("nome")
      .eq("id", pedido.separacao_galpao_id)
      .maybeSingle();
    galpaoNome = (g as { nome?: string } | null)?.nome ?? null;
  }

  await promoverPedidoFutura(sb, {
    pedidoId: pedido.id,
    decisaoFinal: pedido.decisao_final,
    galpaoNome,
    empresaId: pedido.empresa_origem_id,
  });

  logger.info(LOG_SOURCE, "futura promovida via webhook ML (real-time)", {
    pedidoId: pedido.id,
    shipmentId,
  });
  return { handled: true, reason: "promovido", pedidoId: pedido.id };
}
