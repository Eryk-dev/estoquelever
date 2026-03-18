import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { buscarProdutoPorSku, getProdutoDetalhe } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { cancelOcIfEmpty, COMPRAS_ALLOWED_CARGOS } from "@/lib/compras-utils";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

/**
 * POST /api/compras/itens/[itemId]/equivalente
 *
 * Registra um SKU equivalente para o item e move o caso para exceção pendente
 * até a troca ser aplicada externamente no Tiny/plataforma.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await params;

  let body: {
    sku_equivalente?: string;
    fornecedor_equivalente?: string;
    observacao?: string;
    usuario_id?: string;
    cargo?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const {
    sku_equivalente,
    fornecedor_equivalente,
    observacao,
    usuario_id,
    cargo,
  } = body;

  if (cargo && !COMPRAS_ALLOWED_CARGOS.includes(cargo as "admin" | "comprador")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  if (!sku_equivalente?.trim()) {
    return NextResponse.json(
      { error: "sku_equivalente é obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, descricao, produto_id, pedido_id, ordem_compra_id, compra_quantidade_recebida")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    if ((item.compra_quantidade_recebida ?? 0) > 0) {
      return NextResponse.json(
        {
          error:
            "Não é possível trocar por equivalente após entrada de estoque. Cancele o item/pedido ou trate manualmente.",
        },
        { status: 409 },
      );
    }

    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("empresa_origem_id")
      .eq("id", item.pedido_id)
      .single();

    if (pedidoError) {
      throw new Error(`Erro ao buscar pedido do item: ${pedidoError.message}`);
    }

    const empresaOrigemId = pedido?.empresa_origem_id ?? null;
    if (!empresaOrigemId) {
      return NextResponse.json(
        { error: "Empresa de origem do pedido não encontrada" },
        { status: 400 },
      );
    }

    const skuEquivalente = sku_equivalente.trim();
    const { token } = await getValidTokenByEmpresa(empresaOrigemId);
    const produto = await runWithEmpresa(empresaOrigemId, () =>
      buscarProdutoPorSku(token, skuEquivalente),
    );

    if (!produto) {
      return NextResponse.json(
        { error: `SKU equivalente não encontrado na empresa de origem: ${skuEquivalente}` },
        { status: 404 },
      );
    }

    const detalhe = await runWithEmpresa(empresaOrigemId, () =>
      getProdutoDetalhe(token, produto.id),
    );

    const ordemCompraId = item.ordem_compra_id;
    const fornecedor =
      fornecedor_equivalente?.trim() || getFornecedorBySku(skuEquivalente).fornecedor;
    const now = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "equivalente_pendente",
        ordem_compra_id: null,
        comprado_em: null,
        comprado_por: null,
        recebido_em: null,
        recebido_por: null,
        compra_quantidade_recebida: 0,
        compra_equivalente_sku: produto.codigo,
        compra_equivalente_descricao: produto.descricao,
        compra_equivalente_produto_id_tiny: produto.id,
        compra_equivalente_fornecedor: fornecedor,
        compra_equivalente_imagem_url: detalhe.imagemUrl,
        compra_equivalente_gtin: detalhe.gtin,
        compra_equivalente_observacao: observacao?.trim() || null,
        compra_equivalente_definido_em: now,
        compra_equivalente_definido_por: usuario_id ?? null,
        compra_equivalente_sku_original: item.sku,
        compra_equivalente_descricao_original: item.descricao,
        compra_equivalente_produto_id_original: item.produto_id,
        compra_cancelamento_motivo: null,
        compra_cancelamento_solicitado_em: null,
        compra_cancelamento_solicitado_por: null,
        compra_cancelado_em: null,
        compra_cancelado_por: null,
      })
      .eq("id", itemId)
      .select(
        "id, sku, descricao, compra_status, compra_equivalente_sku, compra_equivalente_descricao, compra_equivalente_fornecedor",
      )
      .single();

    if (updateError) {
      throw new Error(`Erro ao registrar equivalente: ${updateError.message}`);
    }

    await cancelOcIfEmpty(supabase, ordemCompraId, "compras-equivalente");

    logger.info("compras-equivalente", "SKU equivalente registrado", {
      itemId,
      pedidoId: item.pedido_id,
      skuOriginal: item.sku,
      skuEquivalente: produto.codigo,
      fornecedor,
    });

    return NextResponse.json({ ok: true, item: updated });
  } catch (err) {
    logger.error("compras-equivalente", "Erro ao registrar SKU equivalente", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao registrar SKU equivalente" },
      { status: 500 },
    );
  }
}
