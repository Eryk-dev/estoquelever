import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export const COMPRAS_ALLOWED_CARGOS = ["admin", "comprador"] as const;

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

export function hasComprasAccess(cargo?: string | null): boolean {
  return !!cargo && COMPRAS_ALLOWED_CARGOS.includes(
    cargo as (typeof COMPRAS_ALLOWED_CARGOS)[number],
  );
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

export async function cancelOcIfEmpty(
  supabase: ReturnType<typeof createServiceClient>,
  ordemCompraId: string | null | undefined,
  logSource: string,
): Promise<void> {
  if (!ordemCompraId) return;

  const { count, error } = await supabase
    .from("siso_pedido_itens")
    .select("id", { count: "exact", head: true })
    .eq("ordem_compra_id", ordemCompraId);

  if (error) {
    logger.warn(logSource, "Falha ao verificar itens restantes da OC", {
      ordemCompraId,
      error: error.message,
    });
    return;
  }

  if ((count ?? 0) > 0) return;

  const { error: updateError } = await supabase
    .from("siso_ordens_compra")
    .update({ status: "cancelado" })
    .eq("id", ordemCompraId);

  if (updateError) {
    logger.warn(logSource, "Falha ao cancelar OC vazia", {
      ordemCompraId,
      error: updateError.message,
    });
    return;
  }

  logger.info(logSource, "OC cancelada (sem itens restantes)", {
    ordemCompraId,
  });
}
