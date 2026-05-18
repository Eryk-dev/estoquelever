import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";

/**
 * DELETE /api/separacao/realocacao/[id]
 * Cancela uma realocação aguardando_picking. Não gera estorno.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    const { data: realoc, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("id, pedido_item_id, status")
      .eq("id", id)
      .single();
    if (realocErr || !realoc) {
      return NextResponse.json({ error: "realocação não encontrada" }, { status: 404 });
    }
    if (realoc.status !== "aguardando_picking") {
      return NextResponse.json(
        { error: `só pode cancelar realocação aguardando_picking (atual: ${realoc.status})` },
        { status: 409 },
      );
    }

    const { error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({ status: "cancelado" })
      .eq("id", id);
    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-realocacao-cancel",
        message: "Falhou cancelar realocação",
        category: "database",
        requestPath: `/api/wms/separacao/realocacao/${id}`,
        requestMethod: "DELETE",
      });
      return NextResponse.json({ error: "erro" }, { status: 500 });
    }

    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id, sku")
      .eq("id", realoc.pedido_item_id)
      .single();

    if (item) {
      await registrarEvento({
        pedidoId: item.pedido_id,
        evento: "realocacao_cancelada",
        detalhes: { realocacao_id: id, sku: item.sku },
        usuarioId: session.id,
      });
    }

    return NextResponse.json({ status: "cancelado" });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-realocacao-cancel",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: `/api/wms/separacao/realocacao/${id}`,
      requestMethod: "DELETE",
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
