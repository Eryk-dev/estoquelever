import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { processarTransferencia } from "@/lib/transferencia-processor";

/**
 * POST /api/transferencia/[id]/processar
 *
 * Starts processing a transfer session (fire-and-forget).
 * Validates: em_andamento status, has items, creator-only.
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

    if (transferencia.status !== "em_andamento") {
      return NextResponse.json(
        { error: "Transferencia nao esta em andamento" },
        { status: 400 },
      );
    }

    const isAdmin = session.cargos.includes("admin");
    if (transferencia.usuario_id !== session.id && !isAdmin) {
      return NextResponse.json(
        { error: "Apenas o criador pode processar esta transferencia" },
        { status: 403 },
      );
    }

    // Check has items
    const { count } = await supabase
      .from("siso_transferencia_itens")
      .select("id", { count: "exact", head: true })
      .eq("transferencia_id", id);

    if (!count || count === 0) {
      return NextResponse.json(
        { error: "Transferencia nao possui itens para processar" },
        { status: 400 },
      );
    }

    // Fire-and-forget
    processarTransferencia(id).catch((err) =>
      logger.logError({
        error: err,
        source: "transferencia",
        message: "Falha no processamento",
        category: "infrastructure",
        metadata: { transferenciaId: id },
      }),
    );

    logger.info("transferencia-processar", "Processamento iniciado", {
      transferenciaId: id,
      usuarioId: session.id,
    });

    return NextResponse.json({ ok: true, message: "Processamento iniciado" });
  } catch (err) {
    logger.error("transferencia-processar", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
