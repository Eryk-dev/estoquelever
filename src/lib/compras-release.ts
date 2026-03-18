/**
 * Release logic for pedidos after OC receiving.
 *
 * When all compra items of a pedido are received, the pedido is
 * released for picking: decisao_final='propria', status='executando',
 * and a job is inserted in siso_fila_execucao.
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";
import { isCompraResolvedForRelease } from "./compras-utils";

/**
 * Check if pedidos linked to the given item IDs can be released.
 * A pedido is released when all its compra items are resolved
 * (`recebido` or `cancelado`) and at least one active item remains.
 *
 * Returns array of released pedido IDs.
 */
export async function checkAndReleasePedidos(
  itemIds: string[],
): Promise<string[]> {
  if (itemIds.length === 0) return [];

  const supabase = createServiceClient();

  // Get distinct pedido_ids from the received items
  const { data: items, error: itemsError } = await supabase
    .from("siso_pedido_itens")
    .select("pedido_id")
    .in("id", itemIds);

  if (itemsError || !items) {
    logger.error("compras-release", "Erro ao buscar pedido_ids dos itens", {
      error: itemsError?.message,
      itemIds,
    });
    return [];
  }

  const pedidoIds = [...new Set(items.map((i) => i.pedido_id as string))];
  const released: string[] = [];

  for (const pedidoId of pedidoIds) {
    // Get ALL items of this pedido that have compra_status set (non-null)
    const { data: allCompraItems, error: compraError } = await supabase
      .from("siso_pedido_itens")
      .select("id, compra_status")
      .eq("pedido_id", pedidoId)
      .not("compra_status", "is", null);

    if (compraError || !allCompraItems) {
      logger.error("compras-release", "Erro ao buscar itens compra do pedido", {
        pedidoId,
        error: compraError?.message,
      });
      continue;
    }

    if (allCompraItems.length === 0) continue;

    const todosResolvidos = allCompraItems.every((item) =>
      isCompraResolvedForRelease(item.compra_status),
    );
    if (!todosResolvidos) continue;

    const { data: anyActiveItem } = await supabase
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedidoId)
      .or("compra_status.is.null,compra_status.neq.cancelado")
      .limit(1)
      .maybeSingle();

    if (!anyActiveItem) {
      logger.info("compras-release", "Pedido não liberado porque todos os itens foram cancelados", {
        pedidoId,
      });
      continue;
    }

    // Get pedido info for the release
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id, status_separacao")
      .eq("id", pedidoId)
      .single();

    if (pedidoError || !pedido) {
      logger.error("compras-release", "Pedido não encontrado para release", {
        pedidoId,
        error: pedidoError?.message,
      });
      continue;
    }

    // Skip if already released or not in compra flow
    if (
      pedido.status_separacao !== "aguardando_compra" &&
      pedido.status_separacao !== "comprado"
    ) {
      continue;
    }

    // Release: update pedido
    const { error: updateError } = await supabase
      .from("siso_pedidos")
      .update({
        decisao_final: "propria",
        status: "executando",
        status_separacao: "aguardando_nf",
      })
      .eq("id", pedidoId);

    if (updateError) {
      logger.error("compras-release", "Erro ao liberar pedido", {
        pedidoId,
        error: updateError.message,
      });
      continue;
    }

    // Insert job in execution queue
    const { error: queueError } = await supabase
      .from("siso_fila_execucao")
      .insert({
        pedido_id: pedidoId,
        tipo: "lancar_estoque",
        empresa_id: pedido.empresa_origem_id,
        decisao: "propria",
      });

    if (queueError) {
      logger.error("compras-release", "Erro ao enfileirar job de release", {
        pedidoId,
        error: queueError.message,
      });
      continue;
    }

    released.push(pedidoId);

    logger.info("compras-release", "Pedido liberado apos recebimento OC", {
      pedidoId,
      empresaOrigemId: pedido.empresa_origem_id,
    });
  }

  return released;
}
