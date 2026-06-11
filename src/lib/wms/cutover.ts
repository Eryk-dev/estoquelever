/**
 * Cutover — liga `estoque_lancado` quando a separação chega em status forward.
 *
 * ARQUITETURA (2026-05-28): a baixa de estoque acontece NO PICK
 * (marcar-item / parcial / pick-OC), atômica, INDEPENDENTE de NF. Quando o
 * pedido chega em status forward todas as reservas R já foram convertidas em
 * L+S pelo pick — então este cutover é um BACKSTOP: liga `estoque_lancado`
 * (= "todos os itens têm sua saída no ledger") e converte qualquer R residual
 * que tenha escapado (guard `estorno_de=R.id` evita dupla baixa). NÃO depende
 * mais de NF — a NF controla só emissão fiscal / expedição.
 *
 * Invariante: dispara quando, e somente quando:
 *   status_separacao ∈ {separado, embalado, expedido}
 *   AND decisao_final ∈ {propria, transferencia}
 *   AND estoque_lancado = false
 *
 * Quem sair do conjunto forward com estoque_lancado=true reverte
 * (desfazer-bip, voltar-etapa backward).
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

// Dynamic import pra evitar dep circular (execution-worker importa cutover)
async function kickWorkerSafe(): Promise<void> {
  try {
    const mod = await import("@/lib/execution-worker");
    await mod.kickWorker();
  } catch (e) {
    logger.warn("wms.cutover", "Falha ao kickar worker (best-effort)", {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// "conferido" (conferência de embalagem, entre embalado e expedido) é forward:
// sem ele aqui, embalado→conferido seria tratado como saída do conjunto e
// reverterCutoverSeRetrocedeu estornaria o estoque de um pedido já embalado.
const FORWARD_STATES = ["separado", "embalado", "conferido", "expedido"] as const;
type ForwardState = (typeof FORWARD_STATES)[number];

export function isForwardStatus(status: string | null | undefined): status is ForwardState {
  return status != null && (FORWARD_STATES as readonly string[]).includes(status);
}

export interface DispararResult {
  enqueued: boolean;
  motivo: string;
}

/**
 * Idempotente: enfileira lancar_estoque_pos_nf se o pedido estiver "pronto":
 * status forward + NF emitida + cutover ainda não rodou.
 *
 * Pode ser chamado em qualquer transição de status sem medo — o worker
 * (`executarEstoquePosNfWms`) já é idempotente via `estoque_lancado` flag
 * e chain `estorno_de`. Skips silenciosos retornam o motivo pra debug.
 */
export async function dispararCutoverSePronto(pedidoId: string): Promise<DispararResult> {
  const sb = createServiceClient();
  const { data: pedido, error } = await sb
    .from("siso_pedidos")
    .select(
      "id, status_separacao, nota_fiscal_id, estoque_lancado, decisao_final, empresa_origem_id",
    )
    .eq("id", pedidoId)
    .maybeSingle();

  if (error || !pedido) {
    logger.warn("wms.cutover", "Pedido não encontrado pra disparar cutover", {
      pedidoId,
      error: error?.message,
    });
    return { enqueued: false, motivo: "pedido_not_found" };
  }

  if (pedido.estoque_lancado) {
    return { enqueued: false, motivo: "ja_lancado" };
  }
  if (!isForwardStatus(pedido.status_separacao)) {
    return { enqueued: false, motivo: `status_nao_forward:${pedido.status_separacao}` };
  }
  // NF NÃO é mais pré-condição (2026-05-28): a baixa vive no pick, atômica e
  // independente de NF. estoque_lancado reflete "itens têm saída no ledger",
  // não "tem NF". Sem este gate, concluir/embalagem sem NF (staging, falha
  // SEFAZ) ainda liga a flag — antes ficava false pra sempre (P0 dessinc).
  if (!pedido.decisao_final) {
    return { enqueued: false, motivo: "sem_decisao_final" };
  }
  if (!pedido.empresa_origem_id) {
    return { enqueued: false, motivo: "sem_empresa_origem" };
  }
  if (!["propria", "transferencia"].includes(pedido.decisao_final)) {
    return { enqueued: false, motivo: `decisao_nao_lancavel:${pedido.decisao_final}` };
  }

  // Dedup: evita enfileirar 2x se já houver job pendente
  const { data: jobExistente } = await sb
    .from("siso_fila_execucao")
    .select("id")
    .eq("pedido_id", pedidoId)
    .eq("tipo", "lancar_estoque_pos_nf")
    .in("status", ["pendente", "processando"])
    .limit(1)
    .maybeSingle();

  if (jobExistente) {
    return { enqueued: false, motivo: "job_ja_pendente" };
  }

  const { error: insertErr } = await sb.from("siso_fila_execucao").insert({
    pedido_id: pedidoId,
    tipo: "lancar_estoque_pos_nf",
    empresa_id: pedido.empresa_origem_id,
    decisao: pedido.decisao_final,
  });

  if (insertErr) {
    logger.error("wms.cutover", "Falha ao enfileirar pos_nf", {
      pedidoId,
      error: insertErr.message,
    });
    return { enqueued: false, motivo: "queue_error" };
  }

  kickWorkerSafe().catch(() => {});

  logger.info("wms.cutover", "Cutover enfileirado", {
    pedidoId,
    status: pedido.status_separacao,
    decisao: pedido.decisao_final,
  });

  return { enqueued: true, motivo: "ok" };
}

export interface ReverterResult {
  reverted: boolean;
  motivo: string;
  saidasEstornadas?: number;
  reservasRecriadas?: number;
  reservasFalhadas?: number;
}

export type ReverterMotivo =
  | "desfazer_bip"
  | "voltar_etapa"
  | "ajuste_admin"
  | "reiniciar_embalagem";

/**
 * Reverte o cutover quando o pedido sai do conjunto forward com
 * estoque_lancado=true. Para cada S existente no ledger do pedido:
 *   1. Insere E compensatória (estorno_de=S.id) — saldo volta
 *   2. Cria R nova na mesma quádrupla — reserva volta
 *
 * Idempotente:
 *   - Se estoque_lancado=false, no-op
 *   - Se novoStatus ainda for forward, no-op
 *   - S que já tem E counter (estorno_de) é pulada
 *
 * Tudo-ou-nada (P023): toda a reversão roda numa única transação na RPC
 * wms_reverter_cutover_atomico. Se outro pedido consumiu o saldo entre cutover
 * e reversal e a recriação da R estourar saldo, a RPC dá RAISE e rola back a
 * reversão INTEIRA (nenhuma S estornada, flag permanece coerente) — nada de
 * estado parcial. Na prática esse RAISE por saldo é inalcançável na mesma loc,
 * pois o estorno-S devolve +qty ao saldo antes de recriar a R(qty).
 */
export async function reverterCutoverSeRetrocedeu(
  pedidoId: string,
  novoStatus: string | null,
  motivo: ReverterMotivo,
  usuarioId?: string,
): Promise<ReverterResult> {
  // 'reiniciar_embalagem' é uma reversão forçada: o operador quer desfazer o
  // cutover (S movs do ledger) mesmo com o pedido permanecendo em 'separado'
  // (status forward). Pula a checagem pra esse motivo específico — os demais
  // (desfazer_bip, voltar_etapa, ajuste_admin) só revertem quando saem do
  // conjunto forward.
  if (motivo !== "reiniciar_embalagem" && isForwardStatus(novoStatus)) {
    return { reverted: false, motivo: "ainda_forward" };
  }

  const sb = createServiceClient();
  const { data: pedido, error } = await sb
    .from("siso_pedidos")
    .select("id, estoque_lancado")
    .eq("id", pedidoId)
    .maybeSingle();

  if (error || !pedido) {
    return { reverted: false, motivo: "pedido_not_found" };
  }

  if (!pedido.estoque_lancado) {
    return { reverted: false, motivo: "estoque_nao_lancado" };
  }

  // SEP-07a: cancela jobs lancar_estoque_pos_nf PENDENTES do pedido ANTES da
  // RPC recriar as R's. Um job stale (enfileirado quando o pedido ainda era
  // forward) rodando depois da reversão converteria as R recém-recriadas em
  // L+S de novo — saída fantasma + baixa dupla no re-pick. Mesmo padrão de
  // cancelamento do pedido-cancel-handler. Se falhar, segue: o gate de status
  // em executarEstoquePosNfWms é o backstop.
  const { data: jobsCancelados, error: cancelErr } = await sb
    .from("siso_fila_execucao")
    .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
    .eq("pedido_id", pedidoId)
    .eq("tipo", "lancar_estoque_pos_nf")
    .eq("status", "pendente")
    .select("id");
  if (cancelErr) {
    logger.warn("wms.cutover", "Falha ao cancelar jobs pos_nf pendentes (segue com reversão)", {
      pedidoId,
      err: cancelErr.message,
    });
  } else if ((jobsCancelados ?? []).length > 0) {
    logger.info("wms.cutover", "Jobs pos_nf pendentes cancelados na reversão", {
      pedidoId,
      motivo,
      jobIds: (jobsCancelados ?? []).map((j) => j.id),
    });
  }

  const { data: rpcRes, error: rpcErr } = await sb.rpc("wms_reverter_cutover_atomico", {
    p_pedido_id: pedidoId,
    p_motivo: motivo,
    p_usuario_id: usuarioId ?? null,
  });
  if (rpcErr) {
    logger.error("wms.cutover", "RPC reverter cutover falhou", {
      pedidoId, motivo, err: rpcErr.message,
    });
    return { reverted: false, motivo: "rpc_error" };
  }
  const res = rpcRes as { reverted: boolean; saidas_estornadas: number; reservas_recriadas: number };
  logger.info("wms.cutover", "Cutover revertido (RPC)", {
    pedidoId, motivo, novoStatus,
    saidasEstornadas: res.saidas_estornadas, reservasRecriadas: res.reservas_recriadas,
  });
  return {
    reverted: res.reverted,
    motivo: "ok",
    saidasEstornadas: res.saidas_estornadas,
    reservasRecriadas: res.reservas_recriadas,
    reservasFalhadas: 0,
  };
}
