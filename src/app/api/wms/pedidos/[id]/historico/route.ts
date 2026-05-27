import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/pedidos/[id]/historico
 *
 * Returns the full audit trail for an order, sorted chronologically.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: pedidoId } = await params;

  // Auth + perm (finding 1.7)
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "pedidos.ver")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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
