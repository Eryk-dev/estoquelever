import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

/**
 * PATCH /api/separacao/{pedidoId}/forcar-pendente
 *
 * Admin-only: force an order from aguardando_nf → aguardando_separacao
 * when the NF webhook fails and the order needs to proceed.
 *
 * Headers: X-Session-Id
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ pedidoId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  if (!session.cargos.includes("admin")) {
    return NextResponse.json(
      { error: "apenas admin pode forçar pendente" },
      { status: 403 },
    );
  }

  const { pedidoId } = await params;

  const supabase = createServiceClient();

  try {
    // 1. Fetch the pedido
    const { data: pedido, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao")
      .eq("id", pedidoId)
      .single();

    if (fetchError || !pedido) {
      return NextResponse.json(
        { error: "pedido não encontrado" },
        { status: 404 },
      );
    }

    // 2. Validate current status
    if (pedido.status_separacao !== "aguardando_nf") {
      return NextResponse.json(
        {
          error: "pedido não está aguardando NF",
          status_atual: pedido.status_separacao,
        },
        { status: 400 },
      );
    }

    // 3. Update to aguardando_separacao
    const { error: updateError } = await supabase
      .from("siso_pedidos")
      .update({ status_separacao: "aguardando_separacao" })
      .eq("id", pedidoId)
      .eq("status_separacao", "aguardando_nf");

    if (updateError) {
      logger.error("separacao-forcar-pendente", "Failed to update pedido", {
        error: updateError.message,
        pedidoId,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    logger.info("separacao-forcar-pendente", "Pedido forçado para aguardando_separacao", {
      pedidoId,
      admin: session.nome,
    });

    return NextResponse.json({ success: true, pedido_id: pedidoId });
  } catch (err) {
    logger.error("separacao-forcar-pendente", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
