import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { cancelOcIfEmpty } from "@/lib/compras-utils";

const ALLOWED_CARGOS = ["admin", "comprador"];

/**
 * POST /api/compras/itens/[itemId]/indisponivel
 *
 * Marks an item as unavailable from the supplier.
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
    // Fetch item to validate and get pedido info
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, descricao, pedido_id, fornecedor_oc, ordem_compra_id")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    const ordemCompraId = item.ordem_compra_id;

    // Mark as indisponivel and unlink from OC
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "indisponivel",
        ordem_compra_id: null,
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
      })
      .eq("id", itemId)
      .select("id, sku, descricao, fornecedor_oc, compra_status, pedido_id")
      .single();

    if (updateError) throw new Error(`Erro ao atualizar item: ${updateError.message}`);

    await cancelOcIfEmpty(supabase, ordemCompraId, "compras-indisponivel");

    logger.warn("compras-indisponivel", "Item marcado como indisponível", {
      itemId,
      sku: item.sku,
      pedidoId: item.pedido_id,
      fornecedor: item.fornecedor_oc,
    });

    return NextResponse.json({ ok: true, item: updated });
  } catch (err) {
    logger.error("compras-indisponivel", "Erro ao marcar item indisponível", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao marcar item indisponível" },
      { status: 500 },
    );
  }
}
