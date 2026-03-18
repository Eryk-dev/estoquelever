import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { cancelOcIfEmpty } from "@/lib/compras-utils";

const ALLOWED_CARGOS = ["admin", "comprador"];

/**
 * POST /api/compras/itens/[itemId]/devolver
 *
 * Returns an item to the "Aguardando Compra" queue by unlinking it from its OC.
 * If the OC has no more items after this, sets OC status to 'cancelado'.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await params;

  let body: { cargo?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // Auth check
  if (body.cargo && !ALLOWED_CARGOS.includes(body.cargo)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  try {
    // Fetch item
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, ordem_compra_id, compra_status, fornecedor_oc, compra_solicitada_em")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    const ordemCompraId = item.ordem_compra_id;

    // Update item: back to aguardando_compra, unlink from OC
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "aguardando_compra",
        ordem_compra_id: null,
        comprado_em: null,
        comprado_por: null,
        compra_equivalente_sku: null,
        compra_equivalente_descricao: null,
        compra_equivalente_produto_id_tiny: null,
        compra_equivalente_fornecedor: null,
        compra_equivalente_imagem_url: null,
        compra_equivalente_gtin: null,
        compra_equivalente_observacao: null,
        compra_equivalente_definido_em: null,
        compra_equivalente_definido_por: null,
        compra_cancelamento_motivo: null,
        compra_cancelamento_solicitado_em: null,
        compra_cancelamento_solicitado_por: null,
        compra_cancelado_em: null,
        compra_cancelado_por: null,
        compra_solicitada_em: item.compra_solicitada_em ?? new Date().toISOString(),
      })
      .eq("id", itemId)
      .select("id, sku, descricao, fornecedor_oc, compra_status")
      .single();

    if (updateError) throw new Error(`Erro ao atualizar item: ${updateError.message}`);

    await cancelOcIfEmpty(supabase, ordemCompraId, "compras-devolver");

    logger.info("compras-devolver", "Item devolvido para fila de compras", {
      itemId,
      sku: updated?.sku,
      ordemCompraIdAnterior: ordemCompraId,
    });

    return NextResponse.json({ ok: true, item: updated });
  } catch (err) {
    logger.error("compras-devolver", "Erro ao devolver item", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao devolver item" },
      { status: 500 },
    );
  }
}
