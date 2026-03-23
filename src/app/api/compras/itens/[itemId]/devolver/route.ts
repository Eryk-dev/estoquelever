import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { buildCompraFieldReset, cancelOcIfEmpty, hasComprasAccess } from "@/lib/compras-utils";

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
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!hasComprasAccess(session.cargos)) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { itemId } = await params;
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
        ...buildCompraFieldReset(),
        compra_status: "aguardando_compra",
        ordem_compra_id: null,
        comprado_em: null,
        comprado_por: null,
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
