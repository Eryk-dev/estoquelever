import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export const COMPRAS_ALLOWED_CARGOS = ["admin", "comprador"] as const;

/** Fields to null when resetting an item's compra exception/equivalente/cancelamento state */
export function buildCompraFieldReset(): Record<string, null> {
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

export function hasComprasAccess(cargo?: string | string[] | null): boolean {
  if (!cargo) return false;
  const cargos = Array.isArray(cargo) ? cargo : [cargo];
  return cargos.some(c => COMPRAS_ALLOWED_CARGOS.includes(
    c as (typeof COMPRAS_ALLOWED_CARGOS)[number],
  ));
}

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

export function getCompraQuantidadeRestante(item: CompraQuantidadeBase): number {
  const solicitada = getCompraQuantidadeSolicitada(item);
  const recebida = Number(item.compra_quantidade_recebida ?? 0);
  return Math.max(solicitada - recebida, 0);
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
