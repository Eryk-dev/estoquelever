import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * GET /api/pedidos/[id]/historico
 *
 * Returns the full audit trail for an order, sorted chronologically.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: pedidoId } = await params;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("siso_pedido_historico")
    .select("id, evento, usuario_id, usuario_nome, detalhes, criado_em")
    .eq("pedido_id", pedidoId)
    .order("criado_em", { ascending: true });

  if (error) {
    logger.error("pedido-historico", "Failed to fetch historico", {
      pedidoId,
      error: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ historico: data ?? [] });
}
