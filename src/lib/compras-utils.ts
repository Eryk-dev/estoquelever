import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { estornarReservaIndividual } from "@/lib/wms/reservas";

/** Fields to null when resetting an item's compra exception/equivalente/cancelamento state */
export function buildCompraFieldReset(): Record<string, null | false> {
  return {
    compra_equivalente_sku: null,
    compra_equivalente_descricao: null,
    compra_equivalente_produto_id_tiny: null,
    compra_equivalente_fornecedor: null,
    compra_equivalente_imagem_url: null,
    compra_equivalente_gtin: null,
    compra_equivalente_observacao: null,
    compra_equivalente_definido_em: null,
    compra_equivalente_definido_por: null,
    compra_cancelamento_motivo: null,
    compra_cancelamento_solicitado_em: null,
    compra_cancelamento_solicitado_por: null,
    compra_cancelado_em: null,
    compra_cancelado_por: null,
    // M6 — limpa estado parcial ao trocar SKU equivalente ou resetar exceção,
    // pra evitar "sujeira" de picking anterior em item que volta pro fluxo.
    quantidade_pega: null,
    separacao_parcial: false,
    parcial_motivo: null,
    parcial_em: null,
    parcial_por: null,
    mov_saida_id: null,
    mov_ajuste_loc_zerou_id: null,
  };
}

export const COMPRA_EXCEPTION_STATUSES = [
  "indisponivel",
  "equivalente_pendente",
  "cancelamento_pendente",
] as const;

const RESOLVED_RELEASE_STATUSES = new Set(["recebido", "cancelado"]);

interface CompraQuantidadeBase {
  compra_quantidade_solicitada?: number | null;
  quantidade_pedida?: number | null;
  compra_quantidade_recebida?: number | null;
  compra_status?: string | null;
}

export type CompraPrioridade = "critica" | "alta" | "normal";

export function isCompraExceptionStatus(status: string | null | undefined): boolean {
  return !!status && COMPRA_EXCEPTION_STATUSES.includes(
    status as (typeof COMPRA_EXCEPTION_STATUSES)[number],
  );
}

export function isCompraResolvedForRelease(status: string | null | undefined): boolean {
  return !!status && RESOLVED_RELEASE_STATUSES.has(status);
}

export function getCompraQuantidadeSolicitada(item: CompraQuantidadeBase): number {
  const solicitada = Number(item.compra_quantidade_solicitada ?? 0);
  if (Number.isFinite(solicitada) && solicitada > 0) {
    return solicitada;
  }

  if (item.compra_status) {
    return Number(item.quantidade_pedida ?? 0);
  }

  return 0;
}

/**
 * Quantidade ainda a receber numa OC.
 *
 * Pode ser **negativo** quando o operador recebeu mais do que o solicitado
 * (over-receive — caso real quando fornecedor manda brinde, contagem errada
 * no recebimento, ou ajuste manual posterior). Callers que tratam esse valor
 * como "quantidade a comprar" devem clampar com Math.max(0, ...); callers
 * que checam saúde da OC (UI de alerta, validações) podem inspecionar o sinal
 * pra sinalizar over-receive como aviso.
 *
 * Antes (até P6) o valor era clampado em zero aqui — ofuscava o problema.
 */
export function getCompraQuantidadeRestante(item: CompraQuantidadeBase): number {
  const solicitada = getCompraQuantidadeSolicitada(item);
  const recebida = Number(item.compra_quantidade_recebida ?? 0);
  return solicitada - recebida;
}

export function getAgingDays(iso: string | null | undefined): number {
  if (!iso) return 0;

  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff <= 0) return 0;

  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function getCompraPrioridade(params: {
  agingDias: number;
  pedidosBloqueados: number;
  quantidadeTotal: number;
  hasException?: boolean;
}): CompraPrioridade {
  const { agingDias, pedidosBloqueados, quantidadeTotal, hasException } = params;

  if (hasException || agingDias >= 3 || pedidosBloqueados >= 4 || quantidadeTotal >= 12) {
    return "critica";
  }

  if (agingDias >= 1 || pedidosBloqueados >= 2 || quantidadeTotal >= 5) {
    return "alta";
  }

  return "normal";
}

const TERMINAL_COMPRA_STATUSES = new Set(["indisponivel", "cancelado"]);

/**
 * Checks if ALL compra items of a pedido are in terminal states (indisponivel/cancelado).
 * If no active items remain, cancels the pedido and its pending queue jobs.
 */
export async function checkAndCancelPedidoIfAllTerminal(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  logSource: string,
): Promise<{ pedidoCancelado: boolean }> {
  const { data: allItems, error } = await supabase
    .from("siso_pedido_itens")
    .select("id, compra_status")
    .eq("pedido_id", pedidoId);

  if (error || !allItems || allItems.length === 0) {
    return { pedidoCancelado: false };
  }

  // If any item has no compra_status (non-OC item) or is not terminal → pedido stays
  const hasActiveItem = allItems.some((item) => {
    if (item.compra_status === null) return true;
    return !TERMINAL_COMPRA_STATUSES.has(item.compra_status);
  });

  if (hasActiveItem) return { pedidoCancelado: false };

  const now = new Date().toISOString();

  await supabase
    .from("siso_pedidos")
    .update({
      status: "cancelado",
      status_separacao: null,
      processado_em: now,
    })
    .eq("id", pedidoId);

  await supabase
    .from("siso_fila_execucao")
    .update({ status: "cancelado", atualizado_em: now })
    .eq("pedido_id", pedidoId)
    .eq("status", "pendente");

  // P038: libera as R vivas do pedido cancelado no ato (não espera cron de expiração).
  // estornarReservaIndividual é idempotente por estorno_de → seguro chamar pra todas.
  const { data: reservasAbertas, error: rQueryErr } = await supabase
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", String(pedidoId));
  if (rQueryErr) {
    logger.warn(logSource, "falha buscando Rs para estorno no cancelamento (prosseguindo)", {
      pedidoId, error: rQueryErr.message,
    });
  }
  let reservasLiberadas = 0;
  for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
    try {
      await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro" });
      reservasLiberadas++;
    } catch (e) {
      logger.warn(logSource, "falha estornando R no cancelamento (segue)", {
        pedidoId,
        reserva_id: r.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logger.warn(logSource, "Pedido cancelado — todos itens de compra terminais", {
    pedidoId,
    totalItens: allItems.length,
    reservasLiberadas,
  });

  return { pedidoCancelado: true };
}

/**
 * Recalculates OC status after an item is removed or changes status.
 * - No items left → status = cancelado
 * - All remaining items are recebido → status = recebido
 * - Some received, some not → status = parcialmente_recebido
 */
export async function cancelOcIfEmpty(
  supabase: ReturnType<typeof createServiceClient>,
  ordemCompraId: string | null | undefined,
  logSource: string,
): Promise<void> {
  if (!ordemCompraId) return;

  const { data: remainingItems, error } = await supabase
    .from("siso_pedido_itens")
    .select("id, compra_status, compra_quantidade_recebida")
    .eq("ordem_compra_id", ordemCompraId);

  if (error) {
    logger.warn(logSource, "Falha ao verificar itens restantes da OC", {
      ordemCompraId,
      error: error.message,
    });
    return;
  }

  let newStatus: string;
  if (!remainingItems || remainingItems.length === 0) {
    newStatus = "cancelado";
  } else {
    const allRecebido = remainingItems.every(
      (item) => item.compra_status === "recebido",
    );
    const someRecebido = remainingItems.some(
      (item) => Number(item.compra_quantidade_recebida ?? 0) > 0,
    );
    if (allRecebido) {
      newStatus = "recebido";
    } else if (someRecebido) {
      newStatus = "parcialmente_recebido";
    } else {
      return; // OC still has unresolved items, keep current status
    }
  }

  const { error: updateError } = await supabase
    .from("siso_ordens_compra")
    .update({ status: newStatus })
    .eq("id", ordemCompraId);

  if (updateError) {
    logger.warn(logSource, `Falha ao atualizar OC para ${newStatus}`, {
      ordemCompraId,
      error: updateError.message,
    });
    return;
  }

  logger.info(logSource, `OC atualizada para ${newStatus}`, {
    ordemCompraId,
    remainingCount: remainingItems?.length ?? 0,
  });
}
