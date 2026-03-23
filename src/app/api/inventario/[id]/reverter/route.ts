import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { reverterInventario } from "@/lib/inventario-processor";

/**
 * POST /api/inventario/[id]/reverter
 *
 * Starts reversal of a completed inventory session (fire-and-forget).
 * Validates: concluido status, creator-only.
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

    if (inventario.status !== "concluido") {
      return NextResponse.json(
        { error: "Só é possível reverter inventários concluídos" },
        { status: 400 },
      );
    }

    // Only creator or admin
    const isAdmin = session.cargos.includes("admin");
    if (inventario.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode reverter este inventário" },
        { status: 403 },
      );
    }

    // Fire-and-forget
    reverterInventario(id).catch((err) =>
      logger.logError({
        error: err,
        source: "inventario",
        message: "Falha na reversão",
        category: "infrastructure",
        metadata: { inventarioId: id },
      }),
    );

    logger.info("inventario-reverter", "Reversão iniciada", {
      inventarioId: id,
      usuarioId: session.id,
    });

    return NextResponse.json({ ok: true, message: "Reversão iniciada" });
  } catch (err) {
    logger.error("inventario-reverter", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
