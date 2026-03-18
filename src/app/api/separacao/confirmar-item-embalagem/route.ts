import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { processarEmbalagem } from "@/lib/embalagem-service";

/**
 * POST /api/separacao/confirmar-item-embalagem
 *
 * Single entry-point for embalagem confirmation.
 *
 * Accepted bodies:
 * - Manual +/-: { pedido_item_id: string, quantidade: number }
 * - Scanner: { sku: string, galpao_id: string, pedido_ids?: string[], quantidade?: number }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  const hasPedidoItemId =
    typeof body?.pedido_item_id === "string" && body.pedido_item_id.length > 0;
  const hasSku =
    typeof body?.sku === "string" && body.sku.trim().length > 0;
  const hasGalpaoId =
    typeof body?.galpao_id === "string" && body.galpao_id.length > 0;

  const quantidade =
    typeof body?.quantidade === "number" && Number.isFinite(body.quantidade)
      ? Math.trunc(body.quantidade)
      : hasPedidoItemId
        ? NaN
        : 1;

  if (hasPedidoItemId) {
    if (!Number.isFinite(quantidade) || quantidade === 0) {
      return NextResponse.json(
        { error: "'pedido_item_id' (string) e 'quantidade' (number != 0) sao obrigatorios" },
        { status: 400 },
      );
    }

    try {
      const result = await processarEmbalagem({
        pedidoItemId: body.pedido_item_id,
        quantidade,
        source: "confirmar-item-embalagem",
      });
      return NextResponse.json(result.body, { status: result.status });
    } catch (err) {
      logger.error("confirmar-item-embalagem", "Unexpected error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Erro interno" }, { status: 500 });
    }
  }

  if (!hasSku || !hasGalpaoId || quantidade <= 0) {
    return NextResponse.json(
      {
        error:
          "Informe 'pedido_item_id' + 'quantidade' ou 'sku' + 'galpao_id' (+ 'quantidade' opcional)",
      },
      { status: 400 },
    );
  }

  const pedidoIds = Array.isArray(body?.pedido_ids)
    ? body.pedido_ids.filter(
        (pedidoId: unknown): pedidoId is string =>
          typeof pedidoId === "string" && pedidoId.length > 0,
      )
    : undefined;

  try {
    const result = await processarEmbalagem({
      sku: body.sku.trim(),
      galpaoId: body.galpao_id,
      pedidoIds,
      quantidade,
      source: "confirmar-item-embalagem",
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    logger.error("confirmar-item-embalagem", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
