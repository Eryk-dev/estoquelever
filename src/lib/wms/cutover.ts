/**
 * Cutover R→L+S — orquestração entre status de separação e ledger WMS.
 *
 * Invariante: o cutover dispara quando, e somente quando:
 *   status_separacao ∈ {separado, embalado, expedido}
 *   AND nota_fiscal_id IS NOT NULL
 *   AND estoque_lancado = false
 *
 * Quem chegar por último na interseção dispara (concluir, executor após NF,
 * webhook NF tardio). Quem sair do conjunto forward com estoque_lancado=true
 * reverte (desfazer-bip, voltar-etapa backward).
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { reservarAtomico } from "./reservas";
import { inserirMovimentacao } from "./ledger";

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

const FORWARD_STATES = ["separado", "embalado", "expedido"] as const;
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
  if (!pedido.nota_fiscal_id) {
    return { enqueued: false, motivo: "sem_nf" };
  }
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
 * Edge case: se outro pedido consumiu o saldo entre cutover e reversal,
 * a recriação da R pode falhar. Sistema mantém a reversão da S e marca
 * status_alerta='reserva_recriacao_falhou' pro operador investigar.
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

  // Busca todas as S do pedido. Há 2 caminhos que produzem S no fluxo de
  // separação WMS:
  //   1. executarEstoquePosNfWms (cutover worker): grava S com origem_id=pedidoId
  //   2. /separacao/marcar-item: grava S sem origem_id, link via
  //      siso_pedido_itens.mov_saida_id ou siso_pedido_item_mov_links
  // Pra cobrir os 2 caminhos, unimos as duas queries.
  const { data: saidasPorOrigem, error: saidasErr } = await sb
    .from("siso_movimentacoes")
    .select("id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("origem_id", pedidoId)
    .eq("origem_tipo", "nf_venda")
    .eq("tipo", "S");

  if (saidasErr) {
    logger.error("wms.cutover", "Falha ao buscar saídas pra reverter", {
      pedidoId,
      error: saidasErr.message,
    });
    return { reverted: false, motivo: "query_error" };
  }

  // Lookup via mov_saida_id em siso_pedido_itens (path marcar-item)
  const { data: itensComMov } = await sb
    .from("siso_pedido_itens")
    .select("mov_saida_id")
    .eq("pedido_id", pedidoId)
    .not("mov_saida_id", "is", null);
  const movSaidaIds = (
    (itensComMov ?? []) as Array<{ mov_saida_id: string | null }>
  )
    .map((i) => i.mov_saida_id)
    .filter((id): id is string => Boolean(id));

  let saidasViaItens: Array<{
    id: string;
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
    quantidade: number;
  }> = [];
  if (movSaidaIds.length > 0) {
    const { data } = await sb
      .from("siso_movimentacoes")
      .select("id, produto_id, galpao_id, localizacao_id, quantidade")
      .in("id", movSaidaIds)
      .eq("tipo", "S");
    saidasViaItens = (data ?? []) as typeof saidasViaItens;
  }

  // Union dedupe por id
  const seen = new Set<string>();
  const saidasArr: Array<{
    id: string;
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
    quantidade: number;
  }> = [];
  for (const s of [
    ...((saidasPorOrigem ?? []) as typeof saidasArr),
    ...saidasViaItens,
  ]) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      saidasArr.push(s);
    }
  }

  if (saidasArr.length === 0) {
    // estoque_lancado=true mas sem S? Estado inconsistente. Limpa flag.
    await sb
      .from("siso_pedidos")
      .update({ estoque_lancado: false, nf_estoque_lancado: false })
      .eq("id", pedidoId);
    logger.warn("wms.cutover", "Pedido com estoque_lancado=true mas sem saídas — flag limpada", {
      pedidoId,
    });
    return { reverted: false, motivo: "sem_saidas_para_estornar" };
  }

  // Idempotência: pula S que já têm E counter
  const saidaIds = saidasArr.map((s) => s.id);
  const { data: jaEstornadas } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .eq("tipo", "E")
    .in("estorno_de", saidaIds);
  const estornadasSet = new Set(
    ((jaEstornadas ?? []) as Array<{ estorno_de: string }>).map((m) => String(m.estorno_de)),
  );

  let saidasEstornadas = 0;
  let reservasRecriadas = 0;
  let reservasFalhadas = 0;

  for (const s of saidasArr) {
    if (estornadasSet.has(s.id)) continue;

    const tripla = {
      produto_id: s.produto_id,
      galpao_id: s.galpao_id,
      localizacao_id: s.localizacao_id,
    };

    try {
      await inserirMovimentacao({
        tripla,
        tipo: "E",
        qty: Number(s.quantidade),
        // 3D: origem_tipo 'cancelamento_nf' não existe mais (lista enxuta).
        // Estorno explícito via estorno_de + origem_tipo 'estorno'.
        origem_tipo: "estorno",
        origem_id: pedidoId,
        origem_detalhes: { motivo, reversal: true },
        estorno_de: s.id,
        usuario_id: usuarioId,
        motivo: `Reversal por ${motivo}`,
      });
      saidasEstornadas++;
    } catch (err) {
      logger.error("wms.cutover", "Falha ao estornar saída", {
        pedidoId,
        saidaId: s.id,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    try {
      await reservarAtomico({
        tripla,
        qty: Number(s.quantidade),
        pedido_id: pedidoId,
        ttl_horas: 24 * 30,
        usuario_id: usuarioId,
      });
      reservasRecriadas++;
    } catch (err) {
      logger.warn("wms.cutover", "Falha ao recriar reserva no reversal", {
        pedidoId,
        tripla,
        qty: s.quantidade,
        err: err instanceof Error ? err.message : String(err),
      });
      reservasFalhadas++;
    }
  }

  await sb
    .from("siso_pedidos")
    .update({ estoque_lancado: false, nf_estoque_lancado: false })
    .eq("id", pedidoId);

  if (reservasFalhadas > 0) {
    try {
      await sb
        .from("siso_pedidos")
        .update({ status_alerta: "reserva_recriacao_falhou" })
        .eq("id", pedidoId);
    } catch {
      // schema legado pode não ter status_alerta — ignora
    }
  }

  logger.info("wms.cutover", "Cutover revertido", {
    pedidoId,
    motivo,
    novoStatus,
    saidasEstornadas,
    reservasRecriadas,
    reservasFalhadas,
  });

  return {
    reverted: true,
    motivo: "ok",
    saidasEstornadas,
    reservasRecriadas,
    reservasFalhadas,
  };
}
