import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/transferencia/[id]
 *
 * Returns full transfer detail with all items.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    const { data: transferencia, error } = await supabase
      .from("siso_transferencias")
      .select(
        "*, empresa_origem:siso_empresas!empresa_origem_id(nome), empresa_destino:siso_empresas!empresa_destino_id(nome), galpao_origem:siso_galpoes!galpao_origem_id(nome), galpao_destino:siso_galpoes!galpao_destino_id(nome), usuario:siso_usuarios(nome)",
      )
      .eq("id", id)
      .single();

    if (error || !transferencia) {
      return NextResponse.json(
        { error: "Transferencia nao encontrada" },
        { status: 404 },
      );
    }

    // Fetch all items
    const { data: itens } = await supabase
      .from("siso_transferencia_itens")
      .select("*")
      .eq("transferencia_id", id)
      .order("created_at", { ascending: false });

    const items = itens ?? [];
    const total_itens = items.length;
    const itens_sucesso = items.filter((i) => i.status === "sucesso").length;
    const itens_erro = items.filter((i) => i.status === "erro").length;

    return NextResponse.json({
      ...transferencia,
      total_itens,
      itens_sucesso,
      itens_erro,
      itens: items,
    });
  } catch (err) {
    logger.error("transferencia-detail", "Erro ao buscar transferencia", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

/**
 * PATCH /api/transferencia/[id]
 *
 * Update transfer: observacoes or set status='cancelado'.
 * Only creator or admin can modify.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  const { id } = await params;
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

    const isAdmin = session.cargos.includes("admin");
    if (transferencia.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode modificar esta transferencia" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (body.observacoes !== undefined) {
      updates.observacoes = body.observacoes;
    }

    if (body.status === "cancelado") {
      if (transferencia.status !== "em_andamento") {
        return NextResponse.json(
          { error: "So e possivel cancelar transferencias em andamento" },
          { status: 400 },
        );
      }
      updates.status = "cancelado";
      updates.concluido_em = new Date().toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "Nenhuma alteracao informada" },
        { status: 400 },
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from("siso_transferencias")
      .update(updates)
      .eq("id", id)
      .select("id, status, observacoes, concluido_em")
      .single();

    if (updateError) {
      logger.error(
        "transferencia-update",
        "Erro ao atualizar transferencia",
        {
          error: updateError.message,
          transferenciaId: id,
        },
      );
      return NextResponse.json(
        { error: "Erro ao atualizar transferencia" },
        { status: 500 },
      );
    }

    logger.info("transferencia-update", "Transferencia atualizada", {
      transferenciaId: id,
      updates: Object.keys(updates),
    });

    return NextResponse.json(updated);
  } catch (err) {
    logger.error("transferencia-update", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
