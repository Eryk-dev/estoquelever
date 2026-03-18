import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

const ALLOWED_CARGOS = ["admin", "comprador"];

/**
 * POST /api/compras/itens/[itemId]/trocar-fornecedor
 *
 * Changes the supplier of an item. Optionally moves it to a new OC.
 * If no nova_ordem_compra_id is provided, item goes back to "Aguardando Compra"
 * with the new fornecedor.
 *
 * Body: { novo_fornecedor: string, nova_ordem_compra_id?: string, cargo?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await params;

  let body: {
    novo_fornecedor?: string;
    nova_ordem_compra_id?: string;
    cargo?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { novo_fornecedor, nova_ordem_compra_id, cargo } = body;

  // Auth check
  if (cargo && !ALLOWED_CARGOS.includes(cargo)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  if (!novo_fornecedor) {
    return NextResponse.json(
      { error: "novo_fornecedor é obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Fetch item
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, fornecedor_oc, ordem_compra_id, compra_status, compra_solicitada_em")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    const ordemCompraIdAnterior = item.ordem_compra_id;

    // Build update fields
    const updateFields: Record<string, unknown> = {
      fornecedor_oc: novo_fornecedor,
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
    };

    if (nova_ordem_compra_id) {
      // Move to a specific existing OC
      updateFields.ordem_compra_id = nova_ordem_compra_id;
      updateFields.compra_status = "comprado";
      updateFields.comprado_em = new Date().toISOString();
    } else {
      // No target OC — back to aguardando_compra queue
      updateFields.ordem_compra_id = null;
      updateFields.compra_status = "aguardando_compra";
      updateFields.comprado_em = null;
      updateFields.comprado_por = null;
      updateFields.compra_solicitada_em =
        item.compra_solicitada_em ?? new Date().toISOString();
    }

    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update(updateFields)
      .eq("id", itemId)
      .select("id, sku, descricao, fornecedor_oc, compra_status, ordem_compra_id")
      .single();

    if (updateError) throw new Error(`Erro ao atualizar item: ${updateError.message}`);

    // Check if old OC still has items — if empty, cancel it
    if (ordemCompraIdAnterior && ordemCompraIdAnterior !== nova_ordem_compra_id) {
      const { count } = await supabase
        .from("siso_pedido_itens")
        .select("id", { count: "exact", head: true })
        .eq("ordem_compra_id", ordemCompraIdAnterior);

      if (count === 0) {
        await supabase
          .from("siso_ordens_compra")
          .update({ status: "cancelado" })
          .eq("id", ordemCompraIdAnterior);

        logger.info("compras-trocar-fornecedor", "OC anterior cancelada (sem itens restantes)", {
          ordemCompraId: ordemCompraIdAnterior,
        });
      }
    }

    logger.info("compras-trocar-fornecedor", "Fornecedor do item alterado", {
      itemId,
      sku: item.sku,
      fornecedorAnterior: item.fornecedor_oc,
      novoFornecedor: novo_fornecedor,
      novaOrdemCompraId: nova_ordem_compra_id ?? null,
    });

    return NextResponse.json({ ok: true, item: updated });
  } catch (err) {
    logger.error("compras-trocar-fornecedor", "Erro ao trocar fornecedor do item", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao trocar fornecedor" },
      { status: 500 },
    );
  }
}
