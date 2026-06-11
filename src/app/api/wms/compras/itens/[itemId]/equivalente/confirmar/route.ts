import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { carregarDadosEquivalentePorSku } from "@/lib/compras-equivalencia";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * P2-CMP-04: libera APENAS as reservas vivas do PRODUTO do item informado —
 * `liberarReserva({pedido_id})` derrubava a R de TODOS os itens do pedido.
 * Resolve o uuid WMS (gotcha #1: siso_produto_empresas por tiny_produto_id +
 * empresa_origem_id), busca as R vivas (sem L apontando) desse produto e
 * estorna cada uma. Produto não-resolvível → warn + não libera nada.
 */
async function liberarReservasDoProdutoDoItem(
  supabase: SupabaseClient,
  args: {
    pedido_id: string;
    tiny_produto_id: string;
    empresa_origem_id: string | null;
    usuario_id: string;
    source: string;
  },
): Promise<number> {
  if (!args.empresa_origem_id) {
    logger.warn(args.source, "sem empresa_origem_id — não libera reserva (conservador)", {
      pedido_id: args.pedido_id,
    });
    return 0;
  }
  let produtoWmsId: string;
  try {
    produtoWmsId = await resolverProdutoWms(args.empresa_origem_id, args.tiny_produto_id);
  } catch (e) {
    logger.warn(args.source, "produto não resolvível — não libera reserva (conservador)", {
      pedido_id: args.pedido_id,
      tiny_produto_id: args.tiny_produto_id,
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }

  const { data: reservas, error: rErr } = await supabase
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", args.pedido_id)
    .eq("produto_id", produtoWmsId);
  if (rErr) {
    logger.warn(args.source, "falha buscando R do produto (segue)", {
      pedido_id: args.pedido_id,
      error: rErr.message,
    });
    return 0;
  }
  const ids = (reservas ?? []).map((r) => r.id as string);
  if (ids.length === 0) return 0;

  // "Viva" = sem L (estorno_de) apontando pra ela.
  const { data: ls } = await supabase
    .from("siso_movimentacoes")
    .select("estorno_de")
    .eq("tipo", "L")
    .in("estorno_de", ids);
  const liberadas = new Set(
    (ls ?? []).map((l) => l.estorno_de as string | null).filter((x): x is string => !!x),
  );

  let liberados = 0;
  for (const id of ids) {
    if (liberadas.has(id)) continue;
    try {
      await estornarReservaIndividual({ reserva_id: id, motivo: "outro", usuario_id: args.usuario_id });
      liberados++;
    } catch (e) {
      logger.warn(args.source, "falha estornando R individual (segue)", {
        reserva_id: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return liberados;
}

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
      .select("empresa_origem_id, separacao_galpao_id")
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
      .select("grupo_id")
      .eq("id", empresaOrigemId)
      .single();

    if (empresaError) {
      throw new Error(`Erro ao buscar empresa de origem: ${empresaError.message}`);
    }

    // P2-CMP-07: NÃO usa mais a coluna deprecada siso_empresas.galpao_id pra
    // determinar o galpão de origem. Prioridade: galpão do pedido
    // (separacao_galpao_id) → 1º preferencial da empresa → 400 claro.
    let galpaoOrigemId =
      (pedido?.separacao_galpao_id as string | null) ?? null;
    if (!galpaoOrigemId) {
      const { data: pref } = await supabase
        .from("siso_empresa_galpoes_preferenciais")
        .select("galpao_id")
        .eq("empresa_id", empresaOrigemId)
        .limit(1)
        .maybeSingle();
      galpaoOrigemId = (pref?.galpao_id as string | null) ?? null;
    }
    if (!galpaoOrigemId) {
      return NextResponse.json(
        {
          error:
            "não foi possível determinar o galpão — defina um galpão preferencial pra empresa",
        },
        { status: 400 },
      );
    }
    const { data: galpaoRow } = await supabase
      .from("siso_galpoes")
      .select("nome")
      .eq("id", galpaoOrigemId)
      .maybeSingle();
    const galpaoOrigemNome = (galpaoRow?.nome as string | null) ?? "";

    const equivalente = await carregarDadosEquivalentePorSku({
      empresaOrigemId,
      grupoId: empresa.grupo_id ?? null,
      galpaoOrigemId,
      galpaoOrigemNome,
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

    // P2 #3.7 + P2-CMP-04: equivalente vira um produto NOVO — a R original
    // (criada pro produto ANTIGO) fica órfã consumindo reservado>saldo após o
    // swap. Libera SÓ a R do produto antigo DESTE item — não a do pedido
    // inteiro (que derrubaria a R de outros itens do mesmo pedido).
    const liberadas = await liberarReservasDoProdutoDoItem(supabase, {
      pedido_id: String(item.pedido_id),
      tiny_produto_id: String(item.produto_id),
      empresa_origem_id: empresaOrigemId,
      usuario_id: session.id,
      source: "compras-equivalente-confirmar",
    });
    logger.info("compras-equivalente-confirmar", "Rs liberadas pré-swap", {
      pedido_id: item.pedido_id,
      item_id: item.id,
      liberadas,
    });

    // (Fase 1.4) REMOVIDO: sync de siso_pedido_item_estoques no swap de SKU
    // equivalente. A tabela foi dropada — estoque do novo SKU é lido vivo de
    // siso_estoque quando o pedido for separado.

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
