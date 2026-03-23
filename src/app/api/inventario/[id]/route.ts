import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { consolidarItens } from "@/lib/inventario-processor";
import type { InventarioItem } from "@/types";

/**
 * GET /api/inventario/[id]
 *
 * Returns full inventory detail with all items + consolidated view.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    // Fetch inventario with joins
    const { data: inventario, error } = await supabase
      .from("siso_inventarios")
      .select(
        "*, empresa:siso_empresas(nome), galpao:siso_galpoes(nome), usuario:siso_usuarios(nome)",
      )
      .eq("id", id)
      .single();

    if (error || !inventario) {
      return NextResponse.json(
        { error: "Inventário não encontrado" },
        { status: 404 },
      );
    }

    // Galpão access check
    if (session.galpaoId && inventario.galpao_id !== session.galpaoId) {
      return NextResponse.json(
        { error: "Inventário não encontrado" },
        { status: 404 },
      );
    }

    // Fetch all items
    const { data: itens } = await supabase
      .from("siso_inventario_itens")
      .select("*")
      .eq("inventario_id", id)
      .order("created_at", { ascending: false });

    // Compute counts
    const items = itens ?? [];
    const total_itens = items.length;
    const itens_sucesso = items.filter((i) => i.status === "sucesso").length;
    const itens_erro = items.filter((i) => i.status === "erro").length;

    // Build consolidated view
    const consolidados = consolidarItens(items as InventarioItem[]);

    return NextResponse.json({
      ...inventario,
      total_itens,
      itens_sucesso,
      itens_erro,
      itens: items,
      consolidados,
    });
  } catch (err) {
    logger.error("inventario-detail", "Erro ao buscar inventário", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

/**
 * PATCH /api/inventario/[id]
 *
 * Update inventory: observacoes or set status='cancelado'.
 * Only creator or admin can modify.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    // Fetch inventario to check ownership
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

    // Only creator or admin
    const isAdmin = session.cargos.includes("admin");
    if (inventario.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode modificar este inventário" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (body.observacoes !== undefined) {
      updates.observacoes = body.observacoes;
    }

    if (body.status === "cancelado") {
      if (inventario.status !== "em_andamento") {
        return NextResponse.json(
          { error: "Só é possível cancelar inventários em andamento" },
          { status: 400 },
        );
      }
      updates.status = "cancelado";
      updates.concluido_em = new Date().toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "Nenhuma alteração informada" },
        { status: 400 },
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from("siso_inventarios")
      .update(updates)
      .eq("id", id)
      .select("id, status, observacoes, concluido_em")
      .single();

    if (updateError) {
      logger.error("inventario-update", "Erro ao atualizar inventário", {
        error: updateError.message,
        inventarioId: id,
      });
      return NextResponse.json(
        { error: "Erro ao atualizar inventário" },
        { status: 500 },
      );
    }

    logger.info("inventario-update", "Inventário atualizado", {
      inventarioId: id,
      updates: Object.keys(updates),
    });

    return NextResponse.json(updated);
  } catch (err) {
    logger.error("inventario-update", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
