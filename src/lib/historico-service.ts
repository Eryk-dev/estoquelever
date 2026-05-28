/**
 * Order history (audit trail) service.
 *
 * Records immutable events to siso_pedido_historico.
 * All functions are fire-and-forget safe — errors are logged, never thrown.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "historico";

/** Hard limit em bytes pro JSONB de `detalhes`. JSONB > 64KB infla index,
 *  faz EXPLAIN ANALYZE ruim e atrapalha realtime payload. */
const MAX_DETALHES_BYTES = 64 * 1024;

/**
 * Garante que `detalhes` não passa de 64KB serializado. Quando excede,
 * substitui pelo marker truncado preservando metadata (`_truncated`,
 * `_original_size_bytes`, `_max_size_bytes`, `_note`). Campos pesados
 * são jogados fora — verificar `siso_logs` por correlation_id pro detalhe
 * original.
 */
export function truncateDetalhes(
  detalhes: Record<string, unknown>,
  ctx: { pedidoId?: string; evento?: string },
): Record<string, unknown> {
  const json = JSON.stringify(detalhes);
  if (json.length <= MAX_DETALHES_BYTES) return detalhes;
  logger.warn(LOG_SOURCE, "detalhes excedeu 64KB — truncated", {
    pedidoId: ctx.pedidoId,
    evento: ctx.evento,
    original_size_bytes: String(json.length),
  });
  return {
    _truncated: true,
    _original_size_bytes: json.length,
    _max_size_bytes: MAX_DETALHES_BYTES,
    _note:
      "campos pesados removidos — verificar siso_logs por correlation_id",
  };
}

export type EventoPedido =
  | "recebido"
  | "auto_aprovado"
  | "aprovado"
  | "aguardando_nf"
  | "nf_autorizada"
  | "aguardando_separacao"
  | "separacao_iniciada"
  | "item_separado"
  | "separacao_concluida"
  | "embalagem_iniciada"
  | "item_embalado"
  | "embalagem_concluida"
  | "etiqueta_impressa"
  | "etiqueta_falhou"
  | "cancelado"
  | "erro"
  | "status_revertido"
  | "encaminhado"
  | "separacao_oc_concluida"
  | "separacao_aguardando_compra"
  | "embalagem_direta_concluida"
  | "oc_item_encontrado"
  | "oc_item_desfazer_encontrado"
  | "oc_item_confirmado"
  | "parcial_loc_zerou"
  | "parcial_em_progresso"
  | "realocacao_picada"
  | "realocacao_parcial"
  | "realocacao_cancelada"
  | "realocacao_cancelada_chain"
  | "realocacao_sem_cobertura_galpao"
  | "realocacao_sem_cobertura_cascade"
  | "realocacao_parcial_cascade"
  | "parcial_desfeito"
  | "separacao_resetada"
  | "separacao_cancelada"
  | "venda_criada_manual"
  | "venda_baixa_direta_executada"
  | "venda_vendedor_atribuido"
  | "compra_item_comprado"
  | "compra_item_recebido"
  | "compra_item_indisponivel"
  | "compra_item_devolvido"
  | "compra_item_cancelado"
  | "compra_item_equivalente_aplicado"
  | "compra_sku_trocado"
  | "compra_pedido_cancelado"
  | "guarda_pendencia_criada"
  | "guarda_pendencia_confirmada"
  | "guarda_pendencia_cancelada"
  | "inventario_patch_aplicado"
  | "expedido"
  | "estorno_manual_admin"
  | "liberar_reservas_admin"
  | "mandado_pra_compras_via_cascade"
  | "recebimento_item_zero"
  | "recebimento_via_oc";

/**
 * Record a single event in the order history.
 * Fire-and-forget safe — logs errors but never throws.
 */
export async function registrarEvento(params: {
  pedidoId: string;
  evento: EventoPedido;
  usuarioId?: string | null;
  usuarioNome?: string | null;
  detalhes?: Record<string, unknown>;
}): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from("siso_pedido_historico").insert({
      pedido_id: params.pedidoId,
      evento: params.evento,
      usuario_id: params.usuarioId ?? null,
      usuario_nome: params.usuarioNome ?? null,
      detalhes: truncateDetalhes(params.detalhes ?? {}, {
        pedidoId: params.pedidoId,
        evento: params.evento,
      }),
    });

    if (error) {
      logger.warn(LOG_SOURCE, "Falha ao registrar evento", {
        pedidoId: params.pedidoId,
        evento: params.evento,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn(LOG_SOURCE, "Erro inesperado ao registrar evento", {
      pedidoId: params.pedidoId,
      evento: params.evento,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record multiple events in batch (single INSERT).
 */
export async function registrarEventos(
  eventos: Array<{
    pedidoId: string;
    evento: EventoPedido;
    usuarioId?: string | null;
    usuarioNome?: string | null;
    detalhes?: Record<string, unknown>;
  }>,
): Promise<void> {
  if (eventos.length === 0) return;

  try {
    const supabase = createServiceClient();
    const rows = eventos.map((e) => ({
      pedido_id: e.pedidoId,
      evento: e.evento,
      usuario_id: e.usuarioId ?? null,
      usuario_nome: e.usuarioNome ?? null,
      detalhes: truncateDetalhes(e.detalhes ?? {}, {
        pedidoId: e.pedidoId,
        evento: e.evento,
      }),
    }));

    const { error } = await supabase.from("siso_pedido_historico").insert(rows);

    if (error) {
      logger.warn(LOG_SOURCE, "Falha ao registrar eventos em lote", {
        count: String(eventos.length),
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn(LOG_SOURCE, "Erro inesperado ao registrar eventos em lote", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
