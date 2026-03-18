import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { processarEmbalagem } from "@/lib/embalagem-service";

/**
 * POST /api/separacao/bipar-embalagem
 *
 * Compatibility alias for older clients.
 * New code should prefer /api/separacao/confirmar-item-embalagem with sku+galpao_id.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (!body?.sku || typeof body.sku !== "string") {
    return NextResponse.json(
      { error: "'sku' (string) e obrigatorio" },
      { status: 400 },
    );
  }
  if (!body?.galpao_id || typeof body.galpao_id !== "string") {
    return NextResponse.json(
      { error: "'galpao_id' (string) e obrigatorio" },
      { status: 400 },
    );
  }

  const quantidade =
    typeof body.quantidade === "number" && Number.isFinite(body.quantidade) && body.quantidade > 0
      ? Math.trunc(body.quantidade)
      : 1;

  const pedidoIds = Array.isArray(body?.pedido_ids)
    ? body.pedido_ids.filter(
        (pedidoId: unknown): pedidoId is string =>
          typeof pedidoId === "string" && pedidoId.length > 0,
      )
    : undefined;

  try {
    const result = await processarEmbalagem({
      sku: body.sku,
      galpaoId: body.galpao_id,
      pedidoIds,
      quantidade,
      source: "bipar-embalagem",
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    logger.error("bipar-embalagem", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
