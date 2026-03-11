import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";

/**
 * POST /api/separacao/forcar-pendente
 *
 * Admin-only: force multiple orders from aguardando_nf → aguardando_separacao.
 *
 * Body: { pedido_ids: string[] }
 * Headers: X-Session-Id (for auth)
 */
export async function POST(request: NextRequest) {
  // Auth: admin only
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  if (session.cargo !== "admin") {
    return NextResponse.json(
      { error: "apenas admin pode forçar pendente" },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);

  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const { pedido_ids } = body as { pedido_ids: string[] };
  const supabase = createServiceClient();

  try {
    // Update only pedidos that are currently aguardando_nf
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedidos")
      .update({ status_separacao: "aguardando_separacao", status_unificado: "aguardando_separacao" })
      .in("id", pedido_ids)
      .eq("status_separacao", "aguardando_nf")
      .select("id");

    if (updateError) {
      logger.error("separacao-forcar-pendente", "Failed to update pedidos", {
        error: updateError.message,
        pedido_ids,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    const updatedIds = (updated ?? []).map((p) => p.id);

    if (updatedIds.length > 0) {
      registrarEventos(
        updatedIds.map((pid) => ({
          pedidoId: pid,
          evento: "nf_autorizada" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: { forcado: true },
        })),
      ).catch(() => {});
    }

    logger.info("separacao", "NF forcada por admin", {
      pedido_ids: updatedIds,
      admin: session.nome,
    });

    return NextResponse.json({
      ok: true,
      pedidos_atualizados: updatedIds,
      total: updatedIds.length,
    });
  } catch (err) {
    logger.error("separacao-forcar-pendente", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
