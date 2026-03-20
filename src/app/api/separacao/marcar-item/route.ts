import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * POST /api/separacao/marcar-item
 *
 * Toggle an item's separacao_marcado checkbox during wave-picking.
 *
 * Body: { pedido_item_id: string, marcado: boolean }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (
    !body ||
    !body.pedido_item_id ||
    typeof body.marcado !== "boolean"
  ) {
    return NextResponse.json(
      { error: "'pedido_item_id' (string) e 'marcado' (boolean) sao obrigatorios" },
      { status: 400 },
    );
  }

  const { pedido_item_id, marcado } = body as {
    pedido_item_id: string;
    marcado: boolean;
  };

  const supabase = createServiceClient();

  try {
    // Fetch the item to get its pedido_id
    const { data: item, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id")
      .eq("id", pedido_item_id)
      .single();

    if (fetchError || !item) {
      return NextResponse.json(
        { error: "Item nao encontrado" },
        { status: 404 },
      );
    }

    // Validate parent pedido is em_separacao
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao")
      .eq("id", item.pedido_id)
      .single();

    if (pedidoError || !pedido) {
      return NextResponse.json(
        { error: "Pedido nao encontrado" },
        { status: 404 },
      );
    }

    const ALLOWED_STATUSES = ["em_separacao", "aguardando_separacao"];
    if (!ALLOWED_STATUSES.includes(pedido.status_separacao)) {
      return NextResponse.json(
        {
          error: "Pedido deve estar com status 'em_separacao' ou 'aguardando_separacao'",
          status_atual: pedido.status_separacao,
        },
        { status: 400 },
      );
    }

    // Update the item
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_marcado: marcado,
        separacao_marcado_em: marcado ? new Date().toISOString() : null,
      })
      .eq("id", pedido_item_id)
      .select()
      .single();

    if (updateError) {
      logger.error("separacao-marcar-item", "Failed to update item", {
        error: updateError.message,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    return NextResponse.json(updated);
  } catch (err) {
    logger.error("separacao-marcar-item", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
