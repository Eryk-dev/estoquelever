import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * POST /api/separacao/bipar-checklist
 *
 * Scan a barcode during wave-picking to auto-check matching items
 * across the given pedidos.
 *
 * Body: { sku: string, pedido_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (
    !body?.sku ||
    typeof body.sku !== "string" ||
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0
  ) {
    return NextResponse.json(
      { error: "'sku' (string) e 'pedido_ids' (string[]) sao obrigatorios" },
      { status: 400 },
    );
  }

  const { sku, pedido_ids } = body as {
    sku: string;
    pedido_ids: string[];
  };

  const supabase = createServiceClient();

  try {
    // Find matching items by SKU within the given pedidos, not yet marked
    let { data: items, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, sku, gtin, compra_status")
      .in("pedido_id", pedido_ids)
      .eq("separacao_marcado", false)
      .eq("sku", sku);

    // If no SKU match, try GTIN match
    if (!fetchError && (!items || items.length === 0)) {
      const gtinResult = await supabase
        .from("siso_pedido_itens")
        .select("id, pedido_id, sku, gtin, compra_status")
        .in("pedido_id", pedido_ids)
        .eq("separacao_marcado", false)
        .eq("gtin", sku);
      items = gtinResult.data;
      fetchError = gtinResult.error;
    }

    if (fetchError) {
      logger.error("separacao-bipar-checklist", "Failed to fetch items", {
        error: fetchError.message,
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    items = (items ?? []).filter((item) => item.compra_status !== "cancelado");

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Nenhum item encontrado com este SKU/GTIN nos pedidos selecionados" },
        { status: 404 },
      );
    }

    const itemIds = items.map((i) => i.id);
    const now = new Date().toISOString();

    // Mark all matched items
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_marcado: true,
        separacao_marcado_em: now,
      })
      .in("id", itemIds)
      .select();

    if (updateError) {
      logger.error("separacao-bipar-checklist", "Failed to update items", {
        error: updateError.message,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    logger.info("separacao-bipar-checklist", "Items marcados via bip", {
      sku,
      pedido_ids,
      items_marcados: itemIds.length,
    });

    return NextResponse.json(updated ?? []);
  } catch (err) {
    logger.error("separacao-bipar-checklist", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
