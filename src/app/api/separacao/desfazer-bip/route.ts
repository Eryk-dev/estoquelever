import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

/**
 * POST /api/separacao/desfazer-bip
 *
 * Undo a bip: decrement quantidade_bipada by 1 for the given item,
 * revert bipado_completo if needed, and revert pedido status if applicable.
 *
 * Headers: X-Session-Id
 * Body: { pedido_id: string, produto_id: number }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  if (!session.galpaoId) {
    return NextResponse.json(
      { error: "admin não pode desfazer bip diretamente" },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_id ||
    typeof body.pedido_id !== "string" ||
    body.produto_id == null ||
    typeof body.produto_id !== "number"
  ) {
    return NextResponse.json(
      { error: "campos 'pedido_id' (string) e 'produto_id' (number) são obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_id, produto_id } = body as {
    pedido_id: string;
    produto_id: number;
  };

  const supabase = createServiceClient();

  try {
    // 1. Validate pedido belongs to operator's galpão
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao, separacao_galpao_id")
      .eq("id", pedido_id)
      .single();

    if (pedidoError || !pedido) {
      return NextResponse.json(
        { error: "pedido não encontrado" },
        { status: 404 },
      );
    }

    if (pedido.separacao_galpao_id !== session.galpaoId) {
      return NextResponse.json(
        { error: "pedido não pertence ao seu galpão" },
        { status: 403 },
      );
    }

    // 2. Fetch the item
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("produto_id, sku, quantidade_pedida, quantidade_bipada, bipado_completo")
      .eq("pedido_id", pedido_id)
      .eq("produto_id", produto_id)
      .single();

    if (itemError || !item) {
      return NextResponse.json(
        { error: "item não encontrado neste pedido" },
        { status: 404 },
      );
    }

    const currentBipada = item.quantidade_bipada ?? 0;
    if (currentBipada <= 0) {
      return NextResponse.json(
        { error: "item não tem bips para desfazer" },
        { status: 400 },
      );
    }

    // 3. Decrement quantidade_bipada by 1
    const newBipada = currentBipada - 1;
    const newBipadoCompleto = newBipada >= item.quantidade_pedida;

    const { error: updateItemError } = await supabase
      .from("siso_pedido_itens")
      .update({
        quantidade_bipada: newBipada,
        bipado_completo: newBipadoCompleto,
      })
      .eq("pedido_id", pedido_id)
      .eq("produto_id", produto_id);

    if (updateItemError) {
      logger.error("separacao-desfazer-bip", "Failed to update item", {
        error: updateItemError.message,
        pedido_id,
        produto_id,
      });
      return NextResponse.json(
        { error: updateItemError.message },
        { status: 500 },
      );
    }

    // 4. Check if pedido status needs reverting
    let newStatusSeparacao = pedido.status_separacao;
    const pedidoUpdates: Record<string, unknown> = {};

    if (pedido.status_separacao === "embalado") {
      // Revert embalado → em_separacao
      newStatusSeparacao = "em_separacao";
      pedidoUpdates.status_separacao = "em_separacao";
      pedidoUpdates.status_unificado = "em_separacao";
      pedidoUpdates.embalagem_concluida_em = null;
      pedidoUpdates.etiqueta_status = null;
    } else if (pedido.status_separacao === "em_separacao") {
      // Check if all bips are now zero across all items
      const { data: allItems } = await supabase
        .from("siso_pedido_itens")
        .select("quantidade_bipada")
        .eq("pedido_id", pedido_id);

      // Sum all bipadas (the current item was already updated)
      const totalBipada = (allItems ?? []).reduce(
        (sum, i) => sum + ((i.quantidade_bipada as number) ?? 0),
        0,
      );

      if (totalBipada === 0) {
        newStatusSeparacao = "aguardando_separacao";
        pedidoUpdates.status_separacao = "aguardando_separacao";
        pedidoUpdates.status_unificado = "aguardando_separacao";
        pedidoUpdates.separacao_operador_id = null;
        pedidoUpdates.separacao_iniciada_em = null;
      }
    }

    if (Object.keys(pedidoUpdates).length > 0) {
      const { error: updatePedidoError } = await supabase
        .from("siso_pedidos")
        .update(pedidoUpdates)
        .eq("id", pedido_id);

      if (updatePedidoError) {
        logger.error("separacao-desfazer-bip", "Failed to update pedido status", {
          error: updatePedidoError.message,
          pedido_id,
        });
        return NextResponse.json(
          { error: updatePedidoError.message },
          { status: 500 },
        );
      }
    }

    logger.info("separacao-desfazer-bip", "Bip desfeito", {
      pedido_id,
      produto_id,
      newBipada,
      newStatusSeparacao,
    });

    return NextResponse.json({
      pedido_id,
      produto_id,
      quantidade_bipada: newBipada,
      bipado_completo: newBipadoCompleto,
      status_separacao: newStatusSeparacao,
    });
  } catch (err) {
    logger.error("separacao-desfazer-bip", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
