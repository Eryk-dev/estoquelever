/**
 * ml-notifications — processa as notificações (webhook) do Mercado Livre.
 *
 * Dois caminhos, ambos da separação futura, em TEMPO REAL (substituem a latência
 * do polling de 30min — que segue de rede de segurança, pois notificação ML não
 * é 100% confiável):
 *
 *  1. INTAKE (tópicos `orders_v2`/`orders`/`created_orders`): venda ML paga cuja
 *     etiqueta o ML segura (shipment.substatus=buffered) NÃO dispara o webhook do
 *     Tiny → o app ficava cego até o polling. Aqui, ao receber a notificação de
 *     pedido, checa o substatus; se buffered e ainda não carregado, acha o pedido
 *     no Tiny (por numeroPedidoEcommerce) e carrega na pista futura
 *     (processWebhook com separacaoFutura=true): reserva, separa, compra cedo.
 *
 *  2. PROMOÇÃO (tópico `shipments`): quando a etiqueta libera (substatus deixa de
 *     ser buffered), casa shipment → pedido (siso_pedidos.ml_shipment_id) e
 *     promove — emite NF + agrupamento igual ao fluxo normal.
 *
 * Idempotente: intake dedup-a por siso_webhook_logs + checa "já carregado";
 * promoção filtra separacao_futura=true (pós-promoção vira no-op). Config do
 * callback/tópicos é manual no DevCenter do app ESTOQUE LEVER.
 */

import { createServiceClient } from "./supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  getMlShipmentStatus,
  getMlShipmentStatusById,
} from "./ml-api";
import { getEmpresaById } from "./empresa-lookup";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { listarPedidos } from "./tiny-api";
import { processWebhook } from "./webhook-processor";
import {
  SUBSTATUS_FUTURA,
  classificarPromocaoFutura,
} from "./wms/separacao-futura";
import { promoverPedidoFutura } from "./webhook-processor-wms";
import { logger } from "./logger";

const LOG_SOURCE = "ml-notifications";
const TOPIC_SHIPMENTS = "shipments";
const TOPICS_ORDER = new Set(["orders_v2", "orders", "created_orders"]);

type SupabaseClient = ReturnType<typeof createServiceClient>;

export interface MlNotification {
  resource?: string | null;
  topic?: string | null;
  user_id?: number | string | null;
  application_id?: number | string | null;
}

export type MlNotifReason =
  | "ignored_topic"
  | "no_shipment_id"
  | "no_order_id"
  | "pedido_nao_encontrado"
  | "sem_conexao_ml"
  | "ja_carregado"
  | "nao_buffered"
  | "tiny_nao_importou"
  | "duplicado"
  | "carregado"
  | "mantido"
  | "ignorado"
  | "promovido"
  | "erro";

export interface MlNotifResult {
  handled: boolean;
  reason: MlNotifReason;
  /** Tiny pedido id afetado (quando aplicável). */
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

/** Extrai o order_id de um resource tipo "/orders/123" (puro, testável). */
export function parseOrderIdFromResource(
  resource: string | null | undefined,
): string | null {
  if (!resource) return null;
  const m = /\/orders\/(\d+)/.exec(resource);
  return m ? m[1] : null;
}

/**
 * Roteia a notificação por tópico. `shipments` → promoção; tópicos de pedido →
 * intake. Qualquer outro é ignorado de barato.
 */
export async function processMlNotification(
  notif: MlNotification,
): Promise<MlNotifResult> {
  if (notif.topic === TOPIC_SHIPMENTS) return processarPromocao(notif);
  if (TOPICS_ORDER.has(notif.topic ?? "")) return processarIntake(notif);
  return { handled: false, reason: "ignored_topic" };
}

// ─── Intake (orders → carrega futura buffered) ──────────────────────────────

async function processarIntake(notif: MlNotification): Promise<MlNotifResult> {
  const orderId = parseOrderIdFromResource(notif.resource);
  if (!orderId) return { handled: false, reason: "no_order_id" };

  const sb = createServiceClient();

  // Já carregado? (id_pedido_ecommerce = order id ML). Se sim, o intake não tem
  // o que fazer — a promoção é tratada pelo tópico `shipments`.
  const { data: existente } = await sb
    .from("siso_pedidos")
    .select("id")
    .eq("id_pedido_ecommerce", orderId)
    .maybeSingle();
  if (existente) return { handled: false, reason: "ja_carregado" };

  // user_id ML (seller) → conexão ML ativa + empresa.
  if (notif.user_id == null) return { handled: false, reason: "sem_conexao_ml" };
  const { data: conn } = await sb
    .from("siso_ml_connections")
    .select("id, empresa_id")
    .eq("ml_user_id", String(notif.user_id))
    .eq("ativo", true)
    .maybeSingle();
  const connRow = conn as { id: string; empresa_id: string | null } | null;
  if (!connRow?.empresa_id) return { handled: false, reason: "sem_conexao_ml" };
  const connId = connRow.id;
  const empresaId = connRow.empresa_id;

  // Só venda buffered entra na pista futura. ready_to_print/outros: o fluxo
  // normal pega quando o pedido aprovar (webhook do Tiny / poll de aprovados).
  const st = await getMlShipmentStatus(connId, orderId);
  if (st?.substatus !== SUBSTATUS_FUTURA) {
    return { handled: false, reason: "nao_buffered" };
  }

  const empresa = await getEmpresaById(empresaId);
  if (!empresa) return { handled: false, reason: "sem_conexao_ml" };

  // Mapeia ML order → Tiny pedido (o processWebhook precisa do id do Tiny).
  // Pode não ter importado ainda no Tiny (corrida) → adia: o polling cobre.
  const { token } = await getValidTokenByEmpresa(empresaId);
  const tinyId = await runWithEmpresa(empresaId, async () => {
    const res = await listarPedidos(token, {
      numeroPedidoEcommerce: orderId,
      limit: 5,
    });
    const itens = res.itens ?? [];
    const hit =
      itens.find((p) => p?.ecommerce?.numeroPedidoEcommerce === orderId) ??
      itens[0];
    return hit?.id != null ? String(hit.id) : null;
  });
  if (!tinyId) {
    logger.info(LOG_SOURCE, "intake futura: pedido ainda não no Tiny (polling cobre)", {
      orderId,
      empresaId,
    });
    return { handled: false, reason: "tiny_nao_importou" };
  }

  // cnpj pro log de webhook (mesma forma do intake por polling).
  const { data: emp } = await sb
    .from("siso_empresas")
    .select("cnpj")
    .eq("id", empresaId)
    .maybeSingle();
  const cnpj = (emp as { cnpj?: string } | null)?.cnpj ?? "";

  // Dedup + processa (espelha sweepFuturaEmpresa do polling).
  const { data: logEntry, error: insErr } = await sb
    .from("siso_webhook_logs")
    .insert({
      tiny_pedido_id: tinyId,
      cnpj,
      tipo: "ml_webhook_intake",
      codigo_situacao: "buffered",
      filial: empresa.galpaoNome,
      empresa_id: empresaId,
      payload: {
        origem: "ml_webhook_intake",
        substatus: st.substatus,
        shipmentId: st.shipmentId,
        orderId,
      },
    })
    .select("id")
    .single();

  if (insErr) {
    // 23505 = dedup_key já existe → já processado/em voo. Idempotente.
    if (insErr.code === "23505") return { handled: false, reason: "duplicado" };
    throw new Error(insErr.message);
  }

  await processWebhook(
    (logEntry as { id: string }).id,
    tinyId,
    empresaId,
    empresa.galpaoId,
    empresa.grupoId,
    true, // separacaoFutura
  );

  logger.info(LOG_SOURCE, "futura carregada via webhook ML (intake real-time)", {
    orderId,
    tinyId,
    empresaId,
  });
  return { handled: true, reason: "carregado", pedidoId: tinyId };
}

// ─── Promoção (shipments → etiqueta liberou) ────────────────────────────────

async function processarPromocao(notif: MlNotification): Promise<MlNotifResult> {
  const shipmentId = parseShipmentIdFromResource(notif.resource);
  if (!shipmentId) return { handled: false, reason: "no_shipment_id" };

  const sb: SupabaseClient = createServiceClient();

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
