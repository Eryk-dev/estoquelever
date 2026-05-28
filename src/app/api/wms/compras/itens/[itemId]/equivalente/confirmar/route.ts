import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { carregarDadosEquivalentePorSku } from "@/lib/compras-equivalencia";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import { liberarReserva } from "@/lib/wms/reservas";

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
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { itemId } = await params;
  const supabase = createServiceClient();

  try {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, descricao, quantidade_pedida, compra_quantidade_solicitada, compra_solicitada_em, compra_status, compra_equivalente_sku, compra_equivalente_fornecedor",
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

    const quantidadeNecessariaCompra =
      Number(item.compra_quantidade_solicitada ?? 0) > 0
        ? Number(item.compra_quantidade_solicitada)
        : Number(item.quantidade_pedida ?? 0);

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
      .select("grupo_id, galpao_id, siso_galpoes!siso_empresas_galpao_id_fkey(nome)")
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
      qtdMinimaAtende: quantidadeNecessariaCompra,
    });

    // [re-audit #3.BROKEN] colunas legacy estoque_cwb_*/estoque_sp_* deixaram
    // de ser escritas — eram zero-readers (grep confirmou). Estoque dinâmico
    // por empresa segue disponível via siso_pedido_item_estoques (tabela
    // normalizada) atualizada logo abaixo. Mesma decisão do Fix-D T10 que
    // removeu cwb_atende/sp_atende neste mesmo arquivo.

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

    // P2 #3.7: equivalente vira um produto NOVO — a R original (criada pra o
    // produto antigo) fica órfã consumindo reservado>saldo após o swap.
    // Liberar Rs do pedido antes de mexer no produto_id.
    try {
      const liberadas = await liberarReserva({
        pedido_id: String(item.pedido_id),
        motivo: "cancelamento",
        usuario_id: session.id,
      });
      logger.info("compras-equivalente-confirmar", "Rs liberadas pré-swap", {
        pedido_id: item.pedido_id,
        item_id: item.id,
        liberadas,
      });
    } catch (e) {
      logger.warn("compras-equivalente-confirmar", "falha liberando R (segue)", {
        error: e instanceof Error ? e.message : String(e),
      });
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
        compra_status: "aguardando_compra",
        ordem_compra_id: null,
        compra_quantidade_solicitada: quantidadeNecessariaCompra,
        compra_solicitada_em: item.compra_solicitada_em ?? new Date().toISOString(),
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

    await registrarEvento({
      pedidoId: item.pedido_id,
      evento: "compra_item_equivalente_aplicado",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        item_id: itemId,
        sku_original: item.sku,
        sku_equivalente: equivalente.sku,
        qty: quantidadeNecessariaCompra,
        fornecedor: item.compra_equivalente_fornecedor ?? equivalente.fornecedor,
      },
    });

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
