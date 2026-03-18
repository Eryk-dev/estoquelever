import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { COMPRAS_ALLOWED_CARGOS } from "@/lib/compras-utils";
import { carregarDadosEquivalentePorSku } from "@/lib/compras-equivalencia";

/**
 * POST /api/compras/itens/[itemId]/equivalente/confirmar
 *
 * Confirma que a troca do item já foi aplicada externamente e sincroniza
 * o item local com o SKU equivalente.
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

  if (body.cargo && !COMPRAS_ALLOWED_CARGOS.includes(body.cargo as "admin" | "comprador")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, descricao, quantidade_pedida, compra_status, compra_equivalente_sku, compra_equivalente_fornecedor",
      )
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    if (item.compra_status !== "equivalente_pendente") {
      return NextResponse.json(
        { error: "O item não está aguardando confirmação de equivalente" },
        { status: 409 },
      );
    }

    if (!item.compra_equivalente_sku) {
      return NextResponse.json(
        { error: "Nenhum SKU equivalente foi registrado para este item" },
        { status: 400 },
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

    const { data: empresa, error: empresaError } = await supabase
      .from("siso_empresas")
      .select("grupo_id, galpao_id, siso_galpoes(nome)")
      .eq("id", empresaOrigemId)
      .single();

    if (empresaError) {
      throw new Error(`Erro ao buscar empresa de origem: ${empresaError.message}`);
    }

    const galpao = empresa?.siso_galpoes as unknown as { nome: string } | null;
    if (!empresa?.galpao_id || !galpao?.nome) {
      return NextResponse.json(
        { error: "Contexto da empresa de origem está incompleto" },
        { status: 400 },
      );
    }

    const equivalente = await carregarDadosEquivalentePorSku({
      empresaOrigemId,
      grupoId: empresa.grupo_id ?? null,
      galpaoOrigemId: empresa.galpao_id,
      galpaoOrigemNome: galpao.nome,
      sku: item.compra_equivalente_sku,
    });

    const { data: duplicate } = await supabase
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", item.pedido_id)
      .eq("produto_id", equivalente.produtoIdOrigem)
      .neq("id", itemId)
      .maybeSingle();

    if (duplicate) {
      return NextResponse.json(
        {
          error:
            "O pedido já possui outro item com este SKU equivalente. A fusão de itens ainda não é suportada automaticamente.",
        },
        { status: 409 },
      );
    }

    await supabase
      .from("siso_pedido_item_estoques")
      .delete()
      .eq("pedido_id", item.pedido_id)
      .eq("produto_id", item.produto_id);

    if (equivalente.estoquesPorEmpresa.length > 0) {
      const { error: estoqueError } = await supabase
        .from("siso_pedido_item_estoques")
        .upsert(
          equivalente.estoquesPorEmpresa.map((estoque) => ({
            pedido_id: item.pedido_id,
            produto_id: estoque.produto_id,
            empresa_id: estoque.empresa_id,
            deposito_id: estoque.deposito_id,
            deposito_nome: estoque.deposito_nome,
            saldo: estoque.saldo,
            reservado: estoque.reservado,
            disponivel: estoque.disponivel,
            localizacao: estoque.localizacao,
          })),
          { onConflict: "pedido_id,produto_id,empresa_id" },
        );

      if (estoqueError) {
        throw new Error(`Erro ao sincronizar estoques do equivalente: ${estoqueError.message}`);
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        produto_id: equivalente.produtoIdOrigem,
        produto_id_suporte: equivalente.produtoIdSuporte,
        produto_id_tiny: equivalente.produtoIdOrigem,
        sku: equivalente.sku,
        descricao: equivalente.descricao,
        fornecedor_oc: item.compra_equivalente_fornecedor ?? equivalente.fornecedor,
        imagem_url: equivalente.imagemUrl,
        gtin: equivalente.gtin,
        estoque_cwb_deposito_id: equivalente.estoqueCwbDepositoId,
        estoque_cwb_deposito_nome: equivalente.estoqueCwbDepositoNome,
        estoque_cwb_saldo: equivalente.estoqueCwbSaldo,
        estoque_cwb_reservado: equivalente.estoqueCwbReservado,
        estoque_cwb_disponivel: equivalente.estoqueCwbDisponivel,
        estoque_sp_deposito_id: equivalente.estoqueSpDepositoId,
        estoque_sp_deposito_nome: equivalente.estoqueSpDepositoNome,
        estoque_sp_saldo: equivalente.estoqueSpSaldo,
        estoque_sp_reservado: equivalente.estoqueSpReservado,
        estoque_sp_disponivel: equivalente.estoqueSpDisponivel,
        cwb_atende: equivalente.estoqueCwbDisponivel >= item.quantidade_pedida,
        sp_atende: equivalente.estoqueSpDisponivel >= item.quantidade_pedida,
        localizacao_cwb: equivalente.localizacaoCwb,
        localizacao_sp: equivalente.localizacaoSp,
        compra_status: "aguardando_compra",
        ordem_compra_id: null,
        comprado_em: null,
        comprado_por: null,
        recebido_em: null,
        recebido_por: null,
        compra_quantidade_recebida: 0,
        compra_cancelamento_motivo: null,
        compra_cancelamento_solicitado_em: null,
        compra_cancelamento_solicitado_por: null,
        compra_cancelado_em: null,
        compra_cancelado_por: null,
      })
      .eq("id", itemId)
      .select("id, sku, descricao, compra_status, fornecedor_oc")
      .single();

    if (updateError) {
      throw new Error(`Erro ao confirmar equivalente: ${updateError.message}`);
    }

    logger.info("compras-equivalente-confirmar", "Equivalente confirmado e sincronizado", {
      itemId,
      pedidoId: item.pedido_id,
      skuAnterior: item.sku,
      skuAtual: equivalente.sku,
    });

    return NextResponse.json({ ok: true, item: updated });
  } catch (err) {
    logger.error("compras-equivalente-confirmar", "Erro ao confirmar equivalente", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao confirmar equivalente" },
      { status: 500 },
    );
  }
}
