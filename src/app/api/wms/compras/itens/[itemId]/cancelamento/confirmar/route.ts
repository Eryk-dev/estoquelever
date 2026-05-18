import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { checkAndReleasePedidos } from "@/lib/compras-release";
import { checkAndCancelPedidoIfAllTerminal, hasComprasAccess } from "@/lib/compras-utils";

/**
 * POST /api/compras/itens/[itemId]/cancelamento/confirmar
 *
 * Confirma que o item já foi cancelado externamente e o remove do fluxo local.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!hasComprasAccess(session.cargos)) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { itemId } = await params;
  const supabase = createServiceClient();

  try {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, compra_status, compra_cancelamento_motivo")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    if (item.compra_status !== "cancelamento_pendente") {
      return NextResponse.json(
        { error: "O item não está aguardando confirmação de cancelamento" },
        { status: 409 },
      );
    }

    await supabase
      .from("siso_pedido_item_estoques")
      .delete()
      .eq("pedido_id", item.pedido_id)
      .eq("produto_id", item.produto_id);

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "cancelado",
        ordem_compra_id: null,
        compra_cancelado_em: now,
        compra_cancelado_por: session.id,
        separacao_marcado: false,
        separacao_marcado_em: null,
        quantidade_bipada: 0,
        bipado_completo: false,
        bipado_em: null,
        bipado_por: null,
      })
      .eq("id", itemId)
      .select("id, sku, descricao, compra_status, compra_cancelamento_motivo")
      .single();

    if (updateError) {
      throw new Error(`Erro ao confirmar cancelamento: ${updateError.message}`);
    }

    const { pedidoCancelado } = await checkAndCancelPedidoIfAllTerminal(
      supabase,
      item.pedido_id,
      "compras-cancelamento-confirmar",
    );

    let pedidosLiberados: string[] = [];
    if (!pedidoCancelado) {
      pedidosLiberados = await checkAndReleasePedidos([itemId]);
    }

    logger.warn("compras-cancelamento-confirmar", "Cancelamento de item confirmado", {
      itemId,
      pedidoId: item.pedido_id,
      sku: item.sku,
      pedidoCancelado,
      pedidosLiberados: pedidosLiberados.length,
    });

    return NextResponse.json({
      ok: true,
      item: updated,
      pedido_cancelado: pedidoCancelado ? item.pedido_id : null,
      pedidos_liberados: pedidosLiberados,
    });
  } catch (err) {
    logger.error("compras-cancelamento-confirmar", "Erro ao confirmar cancelamento do item", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao confirmar cancelamento do item" },
      { status: 500 },
    );
  }
}
