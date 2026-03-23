import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * PATCH /api/transferencia/[id]/itens/[itemId]
 *
 * Update item quantity.
 * Body: { quantidade: number }
 * Returns: { item: { id, quantidade }, total_itens }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  const { id, itemId } = await params;
  const supabase = createServiceClient();

  try {
    const { data: transferencia, error: fetchError } = await supabase
      .from("siso_transferencias")
      .select("id, usuario_id, status")
      .eq("id", id)
      .single();

    if (fetchError || !transferencia) {
      return NextResponse.json(
        { error: "Transferencia nao encontrada" },
        { status: 404 },
      );
    }

    if (transferencia.status !== "em_andamento") {
      return NextResponse.json(
        { error: "Transferencia nao esta em andamento" },
        { status: 400 },
      );
    }

    const isAdmin = session.cargos.includes("admin");
    if (transferencia.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode modificar itens" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { quantidade } = body;

    if (!quantidade || quantidade < 1) {
      return NextResponse.json(
        { error: "Quantidade deve ser maior que 0" },
        { status: 400 },
      );
    }

    const { data: item, error: updateError } = await supabase
      .from("siso_transferencia_itens")
      .update({ quantidade })
      .eq("id", itemId)
      .eq("transferencia_id", id)
      .select("id, quantidade")
      .single();

    if (updateError || !item) {
      return NextResponse.json(
        { error: "Item nao encontrado" },
        { status: 404 },
      );
    }

    const { count } = await supabase
      .from("siso_transferencia_itens")
      .select("id", { count: "exact", head: true })
      .eq("transferencia_id", id);

    return NextResponse.json({ item, total_itens: count ?? 0 });
  } catch (err) {
    logger.error("transferencia-item-patch", "Erro ao atualizar item", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
      itemId,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

/**
 * DELETE /api/transferencia/[id]/itens/[itemId]
 *
 * Delete a scanned item from the transfer.
 * Returns: { ok: true, total_itens }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  const { id, itemId } = await params;
  const supabase = createServiceClient();

  try {
    const { data: transferencia, error: fetchError } = await supabase
      .from("siso_transferencias")
      .select("id, usuario_id, status")
      .eq("id", id)
      .single();

    if (fetchError || !transferencia) {
      return NextResponse.json(
        { error: "Transferencia nao encontrada" },
        { status: 404 },
      );
    }

    if (transferencia.status !== "em_andamento") {
      return NextResponse.json(
        { error: "Transferencia nao esta em andamento" },
        { status: 400 },
      );
    }

    const isAdmin = session.cargos.includes("admin");
    if (transferencia.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode remover itens" },
        { status: 403 },
      );
    }

    const { data: deleted, error: deleteError } = await supabase
      .from("siso_transferencia_itens")
      .delete()
      .eq("id", itemId)
      .eq("transferencia_id", id)
      .select("id")
      .maybeSingle();

    if (deleteError) {
      logger.error("transferencia-item-delete", "Erro ao deletar item", {
        error: deleteError.message,
        transferenciaId: id,
        itemId,
      });
      return NextResponse.json(
        { error: "Erro ao remover item" },
        { status: 500 },
      );
    }

    if (!deleted) {
      return NextResponse.json(
        { error: "Item não encontrado" },
        { status: 404 },
      );
    }

    const { count } = await supabase
      .from("siso_transferencia_itens")
      .select("id", { count: "exact", head: true })
      .eq("transferencia_id", id);

    return NextResponse.json({ ok: true, total_itens: count ?? 0 });
  } catch (err) {
    logger.error("transferencia-item-delete", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
      itemId,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
