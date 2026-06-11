import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { userCan } from "@/lib/permissions";
import { registrarEventos } from "@/lib/historico-service";

/**
 * POST /api/compras/trocar-sku
 *
 * Swaps the SKU of a pedido item to an equivalent product.
 * Resolves the new product via the WMS catalog (siso_produtos +
 * siso_produto_empresas) and applies the tiny_produto_id of EACH item's
 * pedido empresa_origem (gotcha #1: siso_pedido_itens.produto_id é o
 * tiny_produto_id da empresa do pedido — não pode ser o de outra empresa).
 * Items whose empresa has no Tiny mapping for the new SKU are NOT swapped
 * and are reported back in `itens_nao_trocados`.
 * Does NOT auto-release the pedido — the operator decides.
 *
 * Body: {
 *   item_ids: string[],   // siso_pedido_itens IDs to update
 *   novo_sku: string,      // new SKU code
 * }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const itemIds = body.item_ids as string[] | undefined;
  const novoSku = body.novo_sku as string | undefined;

  if (!itemIds?.length || !novoSku?.trim()) {
    return NextResponse.json(
      { error: "Envie { item_ids: string[], novo_sku: string }" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Get items and their pedidos (empresa_origem por item — pode haver
    // itens de pedidos de empresas diferentes no mesmo lote)
    const { data: items, error: fetchErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade_pedida, siso_pedidos(empresa_origem_id)")
      .in("id", itemIds);

    if (fetchErr || !items?.length) {
      return NextResponse.json(
        { error: "Itens não encontrados" },
        { status: 404 },
      );
    }

    const novoFornecedor = getFornecedorBySku(novoSku);

    // Produto novo no catálogo WMS (caso normal de troca: SKU já catalogado).
    const { data: produtoNovo } = await supabase
      .from("siso_produtos")
      .select("id, descricao, imagem_url")
      .eq("sku", novoSku)
      .maybeSingle();

    if (!produtoNovo) {
      return NextResponse.json(
        { error: `SKU "${novoSku}" não encontrado no catálogo WMS (siso_produtos)` },
        { status: 404 },
      );
    }

    // Mapping Tiny por empresa (bridge siso_produto_empresas).
    const { data: mappings, error: mapErr } = await supabase
      .from("siso_produto_empresas")
      .select("empresa_id, tiny_produto_id")
      .eq("produto_id", produtoNovo.id)
      .eq("ativo", true);

    if (mapErr) {
      throw new Error(`Erro ao buscar mapeamentos Tiny: ${mapErr.message}`);
    }

    const tinyPorEmpresa = new Map<string, number>();
    for (const m of mappings ?? []) {
      tinyPorEmpresa.set(m.empresa_id as string, Number(m.tiny_produto_id));
    }

    type ItemRow = {
      id: string;
      pedido_id: string;
      sku: string;
      siso_pedidos: { empresa_origem_id: string | null } | null;
    };
    const itemsTyped = items as unknown as ItemRow[];

    // Agrupa itens por empresa_origem do pedido dono; itens cuja empresa não
    // tem mapping do SKU novo NÃO são trocados (fail loud, sem troca parcial
    // silenciosa com tiny id errado).
    const itensPorEmpresa = new Map<string, ItemRow[]>();
    const naoTrocados: Array<{
      item_id: string;
      pedido_id: string;
      motivo: string;
    }> = [];

    for (const item of itemsTyped) {
      const empresaId = item.siso_pedidos?.empresa_origem_id ?? null;
      if (!empresaId) {
        naoTrocados.push({
          item_id: String(item.id),
          pedido_id: item.pedido_id,
          motivo: "Pedido sem empresa de origem",
        });
        continue;
      }
      if (!tinyPorEmpresa.has(empresaId)) {
        naoTrocados.push({
          item_id: String(item.id),
          pedido_id: item.pedido_id,
          motivo: `SKU "${novoSku}" sem mapeamento Tiny pra empresa ${empresaId} (siso_produto_empresas)`,
        });
        continue;
      }
      const lista = itensPorEmpresa.get(empresaId) ?? [];
      lista.push(item);
      itensPorEmpresa.set(empresaId, lista);
    }

    if (itensPorEmpresa.size === 0) {
      logger.warn("compras-trocar-sku", "Nenhum item pôde ser trocado", {
        novoSku,
        naoTrocados,
      });
      return NextResponse.json(
        {
          error: `Nenhum item pôde ser trocado: SKU "${novoSku}" sem mapeamento Tiny pras empresas dos pedidos`,
          itens_nao_trocados: naoTrocados,
        },
        { status: 422 },
      );
    }

    // Update por empresa — cada grupo recebe o tiny_produto_id DA SUA empresa.
    const trocadosIds: string[] = [];
    for (const [empresaId, itensEmpresa] of itensPorEmpresa) {
      const tinyId = tinyPorEmpresa.get(empresaId)!;
      const ids = itensEmpresa.map((i) => i.id);
      const { error: updateErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          sku: novoSku,
          descricao: produtoNovo.descricao ?? null,
          imagem_url: produtoNovo.imagem_url ?? null,
          produto_id: tinyId,
          fornecedor_oc: novoFornecedor.fornecedor,
        })
        .in("id", ids);

      if (updateErr) {
        throw new Error(
          `Erro ao atualizar itens da empresa ${empresaId}: ${updateErr.message}`,
        );
      }
      trocadosIds.push(...ids.map(String));
    }

    // Audit trail: 1 evento compra_sku_trocado por pedido afetado (só itens
    // efetivamente trocados).
    const trocadosSet = new Set(trocadosIds);
    const itensTrocados = itemsTyped.filter((i) => trocadosSet.has(String(i.id)));
    const pedidoIds = [...new Set(itensTrocados.map((i) => i.pedido_id))];

    if (pedidoIds.length > 0) {
      await registrarEventos(
        pedidoIds.map((pedidoId) => {
          const itensDoPedido = itensTrocados.filter((i) => i.pedido_id === pedidoId);
          const skuAnterior = itensDoPedido[0]?.sku ?? null;
          return {
            pedidoId,
            evento: "compra_sku_trocado" as const,
            usuarioId: session.id,
            usuarioNome: session.nome,
            detalhes: {
              item_ids: itensDoPedido.map((i) => String(i.id)),
              sku_anterior: skuAnterior,
              novo_sku: novoSku,
              novo_fornecedor: novoFornecedor.fornecedor,
            },
          };
        }),
      );
    }

    if (naoTrocados.length > 0) {
      logger.warn("compras-trocar-sku", "Itens NÃO trocados — sem mapeamento Tiny da empresa", {
        novoSku,
        naoTrocados,
      });
    }

    logger.info("compras-trocar-sku", "SKU trocado com sucesso", {
      itemIds: trocadosIds,
      novoSku,
      novoFornecedor: novoFornecedor.fornecedor,
      naoTrocados: naoTrocados.length,
    });

    return NextResponse.json({
      ok: true,
      novo_sku: novoSku,
      novo_fornecedor: novoFornecedor.fornecedor,
      descricao: produtoNovo.descricao ?? null,
      itens_trocados: trocadosIds,
      itens_nao_trocados: naoTrocados,
    });
  } catch (err) {
    logger.error("compras-trocar-sku", "Erro ao trocar SKU", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro interno ao trocar SKU" },
      { status: 500 },
    );
  }
}
