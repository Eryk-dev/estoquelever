import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export const COMPRAS_ALLOWED_CARGOS = ["admin", "comprador"] as const;

export const COMPRA_EXCEPTION_STATUSES = [
  "indisponivel",
  "equivalente_pendente",
  "cancelamento_pendente",
] as const;

const RESOLVED_RELEASE_STATUSES = new Set(["recebido", "cancelado"]);

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
