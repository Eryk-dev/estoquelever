/**
 * Release logic for pedidos after OC receiving.
 *
 * When all compra items of a pedido are received, the pedido is
 * released for picking. The decisão depends on whether the OC's
 * receiving galpão matches the pedido's origin galpão:
 *   - Same galpão → propria (NF + stock exit on same empresa)
 *   - Different galpão → transferencia (NF on origin, stock exit on OC galpão)
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
      .select("id, compra_status, ordem_compra_id")
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

    // Resolve the OC's galpão and the pedido's origin galpão
    const ocGalpaoId = await resolveOcGalpaoId(supabase, allCompraItems);
    const pedidoGalpaoId = await resolveEmpresaGalpaoId(supabase, pedido.empresa_origem_id);

    // If either galpão is unknown, skip release — wrong decisão causes irreversible Tiny mutations
    if (!ocGalpaoId || !pedidoGalpaoId) {
      logger.error("compras-release", "Galpão indefinido — não é possível liberar pedido", {
        pedidoId,
        ocGalpaoId,
        pedidoGalpaoId,
        empresaOrigemId: pedido.empresa_origem_id,
      });
      continue;
    }

    const mesmoGalpao = ocGalpaoId === pedidoGalpaoId;

    // For cross-galpão: find the empresa in the OC galpão for execution
    // Use deterministic ordering to always pick the same empresa
    let empresaExecId = pedido.empresa_origem_id;
    if (!mesmoGalpao) {
      const { data: empresaOcGalpao } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", ocGalpaoId)
        .eq("ativo", true)
        .order("criado_em", { ascending: true })
        .limit(1)
        .single();
      if (empresaOcGalpao) {
        empresaExecId = empresaOcGalpao.id;
      }
    }

    const decisao = mesmoGalpao ? "propria" : "transferencia";

    // Check if NF already arrived (webhook may have saved nota_fiscal_id before release)
    const { data: pedidoNf } = await supabase
      .from("siso_pedidos")
      .select("nota_fiscal_id")
      .eq("id", pedidoId)
      .single();

    const nfJaChegou = !!pedidoNf?.nota_fiscal_id;
    const novoStatusSeparacao = nfJaChegou ? "aguardando_separacao" : "aguardando_nf";

    if (nfJaChegou) {
      logger.info("compras-release", "NF já registrada — pulando direto para aguardando_separacao", {
        pedidoId,
        notaFiscalId: pedidoNf.nota_fiscal_id,
      });
    }

    // Release: update pedido
    const { error: updateError } = await supabase
      .from("siso_pedidos")
      .update({
        decisao_final: decisao,
        status: "executando",
        status_separacao: novoStatusSeparacao,
        // Route separation to the OC's galpão (so correct operator sees it)
        ...(ocGalpaoId ? { separacao_galpao_id: ocGalpaoId } : {}),
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
        empresa_id: empresaExecId,
        decisao,
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
      empresaExecId,
      decisao,
      mesmoGalpao,
      ocGalpaoId,
      pedidoGalpaoId,
    });
  }

  return released;
}

/**
 * Find the OC's galpao_id from the compra items' ordem_compra_id.
 */
async function resolveOcGalpaoId(
  supabase: ReturnType<typeof createServiceClient>,
  compraItems: Array<{ ordem_compra_id: string | null }>,
): Promise<string | null> {
  const ocIds = [...new Set(compraItems.map((i) => i.ordem_compra_id).filter(Boolean))] as string[];
  if (ocIds.length === 0) return null;

  // Check all OCs — warn if they have different galpões
  const { data: ocs } = await supabase
    .from("siso_ordens_compra")
    .select("id, galpao_id")
    .in("id", ocIds);

  if (!ocs || ocs.length === 0) return null;

  const galpaoIds = [...new Set(ocs.map((oc) => oc.galpao_id).filter(Boolean))];
  if (galpaoIds.length > 1) {
    logger.warn("compras-release", "Pedido com OCs em galpões diferentes — usando o primeiro", {
      ocIds,
      galpaoIds,
    });
  }

  return galpaoIds[0] ?? null;
}

/**
 * Get the galpao_id for a given empresa.
 */
async function resolveEmpresaGalpaoId(
  supabase: ReturnType<typeof createServiceClient>,
  empresaId: string | null,
): Promise<string | null> {
  if (!empresaId) return null;

  const { data: empresa } = await supabase
    .from("siso_empresas")
    .select("galpao_id")
    .eq("id", empresaId)
    .single();

  return empresa?.galpao_id ?? null;
}
