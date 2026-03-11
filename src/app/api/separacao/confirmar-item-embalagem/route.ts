import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { buscarEImprimirEtiqueta } from "@/lib/etiqueta-service";
import { registrarEvento } from "@/lib/historico-service";

/**
 * POST /api/separacao/confirmar-item-embalagem
 *
 * Manually confirm item quantities during packing via +/- buttons.
 * Increments quantidade_bipada and checks pedido completion.
 *
 * Body: { pedido_item_id: string, quantidade: number }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (
    !body ||
    !body.pedido_item_id ||
    typeof body.quantidade !== "number"
  ) {
    return NextResponse.json(
      { error: "'pedido_item_id' (string) e 'quantidade' (number) sao obrigatorios" },
      { status: 400 },
    );
  }

  const pedido_item_id: string = body.pedido_item_id;
  const quantidade: number = body.quantidade;

  const supabase = createServiceClient();

  try {
    // Fetch the item to get current state
    const { data: item, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, quantidade_pedida, quantidade_bipada, bipado_completo")
      .eq("id", pedido_item_id)
      .single();

    if (fetchError || !item) {
      return NextResponse.json(
        { error: "Item nao encontrado" },
        { status: 404 },
      );
    }

    // Validate parent pedido is separado (ready for packing)
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

    if (pedido.status_separacao !== "separado") {
      return NextResponse.json(
        {
          error: "Pedido deve estar com status 'separado' para embalagem",
          status_atual: pedido.status_separacao,
        },
        { status: 400 },
      );
    }

    // Calculate new quantidade_bipada (minimum 0)
    const currentBipada = item.quantidade_bipada ?? 0;
    const newBipada = Math.max(0, currentBipada + quantidade);
    const bipado_completo = newBipada >= item.quantidade_pedida;

    // Update the item
    const { error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        quantidade_bipada: newBipada,
        bipado_completo,
      })
      .eq("id", pedido_item_id);

    if (updateError) {
      logger.error("confirmar-item-embalagem", "Failed to update item", {
        error: updateError.message,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    // Check if ALL items of this pedido have bipado_completo = true
    const { count: pendingCount, error: countError } = await supabase
      .from("siso_pedido_itens")
      .select("*", { count: "exact", head: true })
      .eq("pedido_id", item.pedido_id)
      .eq("bipado_completo", false);

    if (countError) {
      logger.error("confirmar-item-embalagem", "Failed to count pending items", {
        error: countError.message,
      });
      return NextResponse.json(
        { error: countError.message },
        { status: 500 },
      );
    }

    const pedido_completo = (pendingCount ?? 0) === 0;

    // If all complete, transition pedido to 'embalado'
    if (pedido_completo) {
      const { error: statusError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "embalado",
          status_unificado: "embalado",
          embalagem_concluida_em: new Date().toISOString(),
        })
        .eq("id", item.pedido_id);

      if (statusError) {
        logger.error("confirmar-item-embalagem", "Failed to update pedido status", {
          error: statusError.message,
          pedido_id: item.pedido_id,
        });
      }
    }

    logger.info("confirmar-item-embalagem", "Item confirmado", {
      pedido_item_id,
      quantidade_bipada: newBipada,
      bipado_completo,
      pedido_completo,
    });

    // Fire-and-forget: record event and trigger label print when packing is complete
    if (pedido_completo) {
      registrarEvento({
        pedidoId: item.pedido_id,
        evento: "embalagem_concluida",
      }).catch(() => {});

      buscarEImprimirEtiqueta(item.pedido_id).catch((err) => {
        logger.error("confirmar-item-embalagem", "Label print trigger failed", {
          pedido_id: item.pedido_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return NextResponse.json({
      pedido_item_id,
      quantidade_bipada: newBipada,
      bipado_completo,
      pedido_completo,
    });
  } catch (err) {
    logger.error("confirmar-item-embalagem", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
