import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { buildCompraFieldReset, cancelOcIfEmpty, checkAndCancelPedidoIfAllTerminal } from "@/lib/compras-utils";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";

/**
 * POST /api/compras/itens/[itemId]/indisponivel
 *
 * Marks an item as unavailable from the supplier.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { itemId } = await params;
  const body = await request.json().catch(() => ({}));
  const motivo = (body as { motivo?: string }).motivo ?? null;
  // P3-05: aceita item_ids[] no body (todos os itens do card de fornecedor),
  // mantendo compat com o itemId da rota. União dedupada.
  const bodyItemIds = Array.isArray((body as { item_ids?: unknown }).item_ids)
    ? ((body as { item_ids: unknown[] }).item_ids
        .filter((x) => typeof x === "string" && x.length > 0) as string[])
    : [];
  const itemIds = [...new Set([itemId, ...bodyItemIds])];
  const supabase = createServiceClient();

  try {
    // Fetch all target items to validate and get pedido info
    const { data: items, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, descricao, pedido_id, fornecedor_oc, ordem_compra_id, compra_solicitada_em")
      .in("id", itemIds);

    if (itemError) {
      throw new Error(`Erro ao buscar itens: ${itemError.message}`);
    }
    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
    }

    const now = new Date().toISOString();
    const ordensTocadas = new Set<string>();
    const pedidosTocados = new Set<string>();
    const atualizados: unknown[] = [];

    for (const item of items) {
      if (item.ordem_compra_id) ordensTocadas.add(item.ordem_compra_id as string);
      pedidosTocados.add(item.pedido_id as string);

      const { data: updated, error: updateError } = await supabase
        .from("siso_pedido_itens")
        .update({
          ...buildCompraFieldReset(),
          compra_status: "indisponivel",
          ordem_compra_id: null,
          compra_solicitada_em: item.compra_solicitada_em ?? now,
          ...(motivo ? { compra_cancelamento_motivo: motivo } : {}),
        })
        .eq("id", item.id)
        .select("id, sku, descricao, fornecedor_oc, compra_status, pedido_id")
        .single();

      if (updateError) throw new Error(`Erro ao atualizar item: ${updateError.message}`);
      atualizados.push(updated);

      await registrarEvento({
        pedidoId: item.pedido_id,
        evento: "compra_item_indisponivel",
        usuarioId: session.id,
        usuarioNome: session.nome,
        detalhes: {
          item_id: item.id,
          sku: item.sku,
          fornecedor: item.fornecedor_oc,
          motivo,
        },
      });
    }

    // OCs e pedidos são checados UMA vez cada (após todos os updates).
    for (const ocId of ordensTocadas) {
      await cancelOcIfEmpty(supabase, ocId, "compras-indisponivel");
    }
    const pedidosCancelados: string[] = [];
    for (const pedidoId of pedidosTocados) {
      const { pedidoCancelado } = await checkAndCancelPedidoIfAllTerminal(
        supabase,
        pedidoId,
        "compras-indisponivel",
      );
      if (pedidoCancelado) pedidosCancelados.push(pedidoId);
    }

    logger.warn("compras-indisponivel", "Itens marcados como indisponível", {
      itemIds,
      total: atualizados.length,
      pedidosCancelados,
    });

    return NextResponse.json({
      ok: true,
      itens: atualizados,
      // Compat: `item` (primeiro) pro caller single legado.
      item: atualizados[0] ?? null,
      pedidos_cancelados: pedidosCancelados,
      pedido_cancelado: pedidosCancelados[0] ?? null,
    });
  } catch (err) {
    logger.error("compras-indisponivel", "Erro ao marcar item indisponível", {
      error: err instanceof Error ? err.message : String(err),
      itemIds,
    });
    return NextResponse.json(
      { error: "Erro interno ao marcar item indisponível" },
      { status: 500 },
    );
  }
}
