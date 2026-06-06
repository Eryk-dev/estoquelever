import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { checkAndReleasePedidos } from "@/lib/compras-release";
import { checkAndCancelPedidoIfAllTerminal } from "@/lib/compras-utils";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import { liberarReserva } from "@/lib/wms/reservas";

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
  if (!userCan(session, "compras.executar")) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

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

    // (Fase 1.4) REMOVIDO: delete de siso_pedido_item_estoques no cancelamento.
    // Tabela dropada — nada a limpar; o estoque vivo é a fonte de verdade.

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
      // P039: o pedido segue vivo (multi-item) mas a R criada pra ESTE item
      // (via reconciliador-oc) fica órfã. liberarReserva é pedido-scoped.
      try {
        const liberadas = await liberarReserva({
          pedido_id: String(item.pedido_id),
          motivo: "cancelamento",
          usuario_id: session.id,
        });
        logger.info("compras-cancelamento-confirmar", "Rs liberadas no cancelamento de item", {
          pedido_id: item.pedido_id,
          item_id: itemId,
          liberadas,
        });
      } catch (e) {
        logger.warn("compras-cancelamento-confirmar", "falha liberando R (segue)", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await registrarEvento({
      pedidoId: item.pedido_id,
      evento: "compra_item_cancelado",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        item_id: itemId,
        sku: item.sku,
        motivo: item.compra_cancelamento_motivo ?? null,
      },
    });

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
