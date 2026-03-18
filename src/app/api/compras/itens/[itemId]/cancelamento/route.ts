import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { cancelOcIfEmpty, COMPRAS_ALLOWED_CARGOS } from "@/lib/compras-utils";

/**
 * POST /api/compras/itens/[itemId]/cancelamento
 *
 * Marca um item como pendente de cancelamento externo.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await params;

  let body: { motivo?: string; usuario_id?: string; cargo?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (body.cargo && !COMPRAS_ALLOWED_CARGOS.includes(body.cargo as "admin" | "comprador")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, descricao, pedido_id, ordem_compra_id")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    const ordemCompraId = item.ordem_compra_id;
    const now = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "cancelamento_pendente",
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
        compra_cancelamento_motivo: body.motivo?.trim() || null,
        compra_cancelamento_solicitado_em: now,
        compra_cancelamento_solicitado_por: body.usuario_id ?? null,
        compra_cancelado_em: null,
        compra_cancelado_por: null,
      })
      .eq("id", itemId)
      .select("id, sku, descricao, compra_status, compra_cancelamento_motivo")
      .single();

    if (updateError) {
      throw new Error(`Erro ao registrar cancelamento pendente: ${updateError.message}`);
    }

    await cancelOcIfEmpty(supabase, ordemCompraId, "compras-cancelamento");

    logger.warn("compras-cancelamento", "Item marcado para cancelamento externo", {
      itemId,
      pedidoId: item.pedido_id,
      sku: item.sku,
      motivo: body.motivo ?? null,
    });

    return NextResponse.json({ ok: true, item: updated });
  } catch (err) {
    logger.error("compras-cancelamento", "Erro ao registrar cancelamento pendente", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao registrar cancelamento do item" },
      { status: 500 },
    );
  }
}
