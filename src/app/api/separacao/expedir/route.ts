import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

/**
 * POST /api/separacao/expedir
 *
 * Mark packed orders as shipped (embalado → expedido).
 *
 * Headers: X-Session-Id
 * Body: { pedido_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  if (!session.galpaoId) {
    return NextResponse.json(
      { error: "admin não pode expedir diretamente" },
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
      { error: "'pedido_ids' deve ser um array não-vazio de strings" },
      { status: 400 },
    );
  }

  const { pedido_ids } = body as { pedido_ids: string[] };

  const supabase = createServiceClient();

  try {
    // 1. Fetch all referenced pedidos
    const { data: pedidos, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao, separacao_galpao_id")
      .in("id", pedido_ids);

    if (fetchError) {
      logger.error("separacao-expedir", "Failed to fetch pedidos", {
        error: fetchError.message,
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    // 2. Validate all pedidos belong to operator's galpão
    const wrongGalpao = (pedidos ?? []).filter(
      (p) => p.separacao_galpao_id !== session.galpaoId,
    );
    if (wrongGalpao.length > 0) {
      return NextResponse.json(
        {
          error: "pedidos não pertencem ao seu galpão",
          pedido_ids: wrongGalpao.map((p) => p.id),
        },
        { status: 403 },
      );
    }

    // Check for missing pedidos (IDs not found in DB)
    const foundIds = new Set((pedidos ?? []).map((p) => p.id));
    const missingIds = pedido_ids.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      return NextResponse.json(
        { error: "pedidos não encontrados", pedido_ids: missingIds },
        { status: 404 },
      );
    }

    // 3. Validate all pedidos have status_separacao = 'embalado'
    const notEmbalado = (pedidos ?? []).filter(
      (p) => p.status_separacao !== "embalado",
    );
    if (notEmbalado.length > 0) {
      return NextResponse.json(
        {
          error: "pedidos não estão embalados",
          pedido_ids: notEmbalado.map((p) => p.id),
        },
        { status: 400 },
      );
    }

    // 4. Update all to expedido
    const { count, error: updateError } = await supabase
      .from("siso_pedidos")
      .update({ status_separacao: "expedido" })
      .in("id", pedido_ids)
      .eq("status_separacao", "embalado");

    if (updateError) {
      logger.error("separacao-expedir", "Failed to update pedidos", {
        error: updateError.message,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    logger.info("separacao-expedir", "Pedidos expedidos", {
      pedido_ids,
      updated: count,
      usuario: session.nome,
    });

    return NextResponse.json({ updated: count ?? pedido_ids.length });
  } catch (err) {
    logger.error("separacao-expedir", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
