import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { processarInventario } from "@/lib/inventario-processor";

/**
 * POST /api/inventario/[id]/processar
 *
 * Starts processing an inventory session (fire-and-forget).
 * Validates: em_andamento status, has items, creator-only.
 */
export async function POST(
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
    // Fetch inventario
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

    // Only creator or admin
    const isAdmin = session.cargos.includes("admin");
    if (inventario.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode processar este inventário" },
        { status: 403 },
      );
    }

    // Check has items
    const { count } = await supabase
      .from("siso_inventario_itens")
      .select("id", { count: "exact", head: true })
      .eq("inventario_id", id);

    if (!count || count === 0) {
      return NextResponse.json(
        { error: "Inventário não possui itens para processar" },
        { status: 400 },
      );
    }

    // Optimistic lock: atomically set status to processando (CAS)
    const { data: locked, error: lockError } = await supabase
      .from("siso_inventarios")
      .update({ status: "processando", processado_em: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "em_andamento")
      .select("id")
      .single();

    if (lockError || !locked) {
      return NextResponse.json(
        { error: "Inventário já está sendo processado" },
        { status: 409 },
      );
    }

    // Fire-and-forget (processor skips its own status update since we already set it)
    processarInventario(id).catch((err) =>
      logger.logError({
        error: err,
        source: "inventario",
        message: "Falha no processamento",
        category: "infrastructure",
        metadata: { inventarioId: id },
      }),
    );

    logger.info("inventario-processar", "Processamento iniciado", {
      inventarioId: id,
      usuarioId: session.id,
    });

    return NextResponse.json({ ok: true, message: "Processamento iniciado" });
  } catch (err) {
    logger.error("inventario-processar", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
