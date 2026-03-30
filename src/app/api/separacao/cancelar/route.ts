import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * POST /api/separacao/cancelar
 *
 * Cancel an in-progress separation: resets all item checkmarks
 * and moves pedidos back to their correct status.
 * Pedidos with pending compra items return to 'aguardando_compra'.
 * All others return to 'aguardando_separacao'.
 *
 * Body: { pedido_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const { pedido_ids } = body as { pedido_ids: string[] };
  const supabase = createServiceClient();

  try {
    // 1. Reset all item checkmarks for the given pedidos
    const { error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_marcado: false,
        separacao_marcado_em: null,
      })
      .in("pedido_id", pedido_ids);

    if (itemsError) {
      logger.error("separacao-cancelar", "Failed to reset items", {
        error: itemsError.message,
      });
      return NextResponse.json(
        { error: itemsError.message },
        { status: 500 },
      );
    }

    // 2. Find pedidos that have pending compra items (should go back to aguardando_compra)
    const { data: compraRows } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id")
      .in("pedido_id", pedido_ids)
      .not("compra_status", "is", null)
      .neq("compra_status", "recebido");

    const compraIds = [...new Set((compraRows ?? []).map((r) => r.pedido_id))];
    const nonCompraIds = pedido_ids.filter((id) => !compraIds.includes(id));

    const resetFields = {
      separacao_operador_id: null,
      separacao_iniciada_em: null,
    };

    // Reset pedidos with pending compra items back to aguardando_compra
    if (compraIds.length > 0) {
      const { error: compraError } = await supabase
        .from("siso_pedidos")
        .update({ ...resetFields, status_separacao: "aguardando_compra" })
        .in("id", compraIds);

      if (compraError) {
        logger.error("separacao-cancelar", "Failed to reset compra pedidos", {
          error: compraError.message,
        });
        return NextResponse.json({ error: compraError.message }, { status: 500 });
      }
    }

    // Reset remaining pedidos back to aguardando_separacao
    const { error: pedidosError } = nonCompraIds.length > 0
      ? await supabase
          .from("siso_pedidos")
          .update({ ...resetFields, status_separacao: "aguardando_separacao" })
          .in("id", nonCompraIds)
      : { error: null };

    if (pedidosError) {
      logger.error("separacao-cancelar", "Failed to reset pedidos", {
        error: pedidosError.message,
      });
      return NextResponse.json(
        { error: pedidosError.message },
        { status: 500 },
      );
    }

    logger.info("separacao-cancelar", "Separação cancelada", {
      pedido_ids,
      aguardando_compra: compraIds,
      aguardando_separacao: nonCompraIds,
    });

    return NextResponse.json({ ok: true, pedido_ids });
  } catch (err) {
    logger.error("separacao-cancelar", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
