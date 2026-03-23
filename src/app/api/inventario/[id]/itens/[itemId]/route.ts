import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * PATCH /api/inventario/[id]/itens/[itemId]
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
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { id, itemId } = await params;
  const supabase = createServiceClient();

  try {
    // Validate inventario status and ownership
    const { data: inventario, error: fetchError } = await supabase
      .from("siso_inventarios")
      .select("id, usuario_id, status")
      .eq("id", id)
      .single();

    if (fetchError || !inventario) {
      return NextResponse.json(
        { error: "Inventário não encontrado" },
        { status: 404 },
      );
    }

    if (inventario.status !== "em_andamento") {
      return NextResponse.json(
        { error: "Inventário não está em andamento" },
        { status: 400 },
      );
    }

    const isAdmin = session.cargos.includes("admin");
    if (inventario.usuario_id !== session.id && !isAdmin) {
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
      .from("siso_inventario_itens")
      .update({ quantidade })
      .eq("id", itemId)
      .eq("inventario_id", id)
      .select("id, quantidade")
      .single();

    if (updateError || !item) {
      return NextResponse.json(
        { error: "Item não encontrado" },
        { status: 404 },
      );
    }

    const { count } = await supabase
      .from("siso_inventario_itens")
      .select("id", { count: "exact", head: true })
      .eq("inventario_id", id);

    return NextResponse.json({ item, total_itens: count ?? 0 });
  } catch (err) {
    logger.error("inventario-item-patch", "Erro ao atualizar item", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
      itemId,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

/**
 * DELETE /api/inventario/[id]/itens/[itemId]
 *
 * Delete a scanned item from the inventory.
 * Returns: { ok: true, total_itens }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { id, itemId } = await params;
  const supabase = createServiceClient();

  try {
    // Validate inventario status and ownership
    const { data: inventario, error: fetchError } = await supabase
      .from("siso_inventarios")
      .select("id, usuario_id, status")
      .eq("id", id)
      .single();

    if (fetchError || !inventario) {
      return NextResponse.json(
        { error: "Inventário não encontrado" },
        { status: 404 },
      );
    }

    if (inventario.status !== "em_andamento") {
      return NextResponse.json(
        { error: "Inventário não está em andamento" },
        { status: 400 },
      );
    }

    const isAdmin = session.cargos.includes("admin");
    if (inventario.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode remover itens" },
        { status: 403 },
      );
    }

    const { error: deleteError } = await supabase
      .from("siso_inventario_itens")
      .delete()
      .eq("id", itemId)
      .eq("inventario_id", id);

    if (deleteError) {
      logger.error("inventario-item-delete", "Erro ao deletar item", {
        error: deleteError.message,
        inventarioId: id,
        itemId,
      });
      return NextResponse.json(
        { error: "Erro ao remover item" },
        { status: 500 },
      );
    }

    const { count } = await supabase
      .from("siso_inventario_itens")
      .select("id", { count: "exact", head: true })
      .eq("inventario_id", id);

    return NextResponse.json({ ok: true, total_itens: count ?? 0 });
  } catch (err) {
    logger.error("inventario-item-delete", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
      itemId,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
