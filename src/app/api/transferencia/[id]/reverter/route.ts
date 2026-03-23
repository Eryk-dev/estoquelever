import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { reverterTransferencia } from "@/lib/transferencia-processor";

/**
 * POST /api/transferencia/[id]/reverter
 *
 * Starts reversal of a completed transfer session (fire-and-forget).
 * Validates: concluido status, creator-only.
 */
export async function POST(
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

    if (transferencia.status !== "concluido") {
      return NextResponse.json(
        { error: "So e possivel reverter transferencias concluidas" },
        { status: 400 },
      );
    }

    const isAdmin = session.cargos.includes("admin");
    if (transferencia.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode reverter esta transferencia" },
        { status: 403 },
      );
    }

    // Optimistic lock: atomically set status to revertendo (CAS)
    const { data: locked, error: lockError } = await supabase
      .from("siso_transferencias")
      .update({ status: "revertendo" })
      .eq("id", id)
      .eq("status", "concluido")
      .select("id")
      .single();

    if (lockError || !locked) {
      return NextResponse.json(
        { error: "Transferencia ja esta sendo revertida" },
        { status: 409 },
      );
    }

    // Fire-and-forget (processor skips its own status update since we already set it)
    reverterTransferencia(id).catch((err) =>
      logger.logError({
        error: err,
        source: "transferencia",
        message: "Falha na reversao",
        category: "infrastructure",
        metadata: { transferenciaId: id },
      }),
    );

    logger.info("transferencia-reverter", "Reversao iniciada", {
      transferenciaId: id,
      usuarioId: session.id,
    });

    return NextResponse.json({ ok: true, message: "Reversao iniciada" });
  } catch (err) {
    logger.error("transferencia-reverter", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
