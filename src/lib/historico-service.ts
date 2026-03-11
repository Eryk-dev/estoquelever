/**
 * Order history (audit trail) service.
 *
 * Records immutable events to siso_pedido_historico.
 * All functions are fire-and-forget safe — errors are logged, never thrown.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "historico";

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
  | "status_revertido";

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
      detalhes: params.detalhes ?? {},
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
      detalhes: e.detalhes ?? {},
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
