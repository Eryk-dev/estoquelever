import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { buscarProdutoPorSku } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { ensureProdutoFromTiny } from "@/lib/wms/sync-tiny";
import { processWebhookWms } from "@/lib/webhook-processor-wms";
import type { TinyPedidoDetalhe } from "@/lib/tiny-api";

/**
 * POST /api/wms/pedidos/[id]/itens/[itemId]/definir-sku
 *
 * Resolve um item de pedido que veio do Tiny SEM vínculo de produto
 * (produto_id=0 — ex. anúncio sem produto associado, "VERIFICAR LADO"). O
 * operador informa o SKU correto; o endpoint:
 *   1. Resolve o produto no catálogo WMS (siso_produtos) pelo SKU.
 *   2. Resolve o tiny_produto_id pra empresa do pedido (bridge
 *      siso_produto_empresas); se faltar, busca no Tiny por SKU e auto-provisiona
 *      (ensureProdutoFromTiny → cria produto + bridge + sync).
 *   3. Corrige o item no payload_original do pedido (id/sku/descricao).
 *   4. Reprocessa o pedido nativo via processWebhookWms — agora com todos os
 *      itens resolvidos, ele roteia (propria/transferência/OC), cria reservas e
 *      enfileira o lançamento como qualquer pedido novo.
 *
 * Body: { sku: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "pedidos.aprovar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: pedidoId, itemId } = await params;
  const body = await request.json().catch(() => ({}));
  const novoSku = (body.sku as string | undefined)?.trim();
  if (!novoSku) {
    return NextResponse.json({ error: "Envie { sku: string }" }, { status: 400 });
  }

  const sb = createServiceClient();

  try {
    // 1. Item + guards de estado
    const { data: item } = await sb
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade_pega, separacao_parcial")
      .eq("id", itemId)
      .eq("pedido_id", pedidoId)
      .maybeSingle();
    if (!item) {
      return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
    }
    if (Number(item.produto_id) !== 0) {
      return NextResponse.json(
        { error: "Item já tem produto vinculado — use trocar-sku" },
        { status: 409 },
      );
    }
    if (Number(item.quantidade_pega ?? 0) > 0 || item.separacao_parcial) {
      return NextResponse.json(
        { error: "Item já em separação — desfaça antes de definir o SKU" },
        { status: 409 },
      );
    }

    const { data: pedido } = await sb
      .from("siso_pedidos")
      .select(
        "id, empresa_origem_id, separacao_galpao_id, estoque_lancado, payload_original",
      )
      .eq("id", pedidoId)
      .maybeSingle();
    if (!pedido) {
      return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
    }
    if (pedido.estoque_lancado) {
      return NextResponse.json(
        { error: "Pedido com estoque já lançado — não dá pra redefinir SKU" },
        { status: 409 },
      );
    }
    const empresaId = pedido.empresa_origem_id as string | null;
    if (!empresaId) {
      return NextResponse.json({ error: "Pedido sem empresa de origem" }, { status: 422 });
    }

    // 2. Produto no catálogo WMS
    const { data: produtoNovo } = await sb
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

    // 3. tiny_produto_id pra empresa do pedido (bridge; auto-provisiona se faltar)
    let tinyId: number | null = null;
    const { data: bridge } = await sb
      .from("siso_produto_empresas")
      .select("tiny_produto_id")
      .eq("produto_id", produtoNovo.id)
      .eq("empresa_id", empresaId)
      .eq("ativo", true)
      .maybeSingle();
    if (bridge?.tiny_produto_id) {
      tinyId = Number(bridge.tiny_produto_id);
    } else {
      try {
        const { token } = await getValidTokenByEmpresa(empresaId);
        const achado = await runWithEmpresa(empresaId, () =>
          buscarProdutoPorSku(token, novoSku),
        );
        if (!achado) {
          return NextResponse.json(
            { error: `SKU "${novoSku}" não encontrado no Tiny da empresa do pedido` },
            { status: 422 },
          );
        }
        await ensureProdutoFromTiny(novoSku, empresaId, achado.id);
        tinyId = achado.id;
      } catch (e) {
        logger.error("pedidos.definir-sku", "falha resolvendo produto no Tiny", {
          pedidoId,
          itemId,
          sku: novoSku,
          error: e instanceof Error ? e.message : String(e),
        });
        return NextResponse.json(
          { error: "Falha ao resolver o produto no Tiny" },
          { status: 502 },
        );
      }
    }

    // 4. Corrige o item no payload_original
    const payload = pedido.payload_original as unknown as TinyPedidoDetalhe | null;
    if (!payload?.itens?.length) {
      return NextResponse.json(
        { error: "Pedido sem payload original pra reprocessar" },
        { status: 422 },
      );
    }
    const alvo =
      payload.itens.find((it) => it.produto.id === 0 && it.produto.sku === item.sku) ??
      payload.itens.find((it) => it.produto.id === 0);
    if (!alvo) {
      return NextResponse.json(
        { error: "Item sem produto vinculado não encontrado no payload" },
        { status: 422 },
      );
    }
    alvo.produto.id = tinyId;
    alvo.produto.sku = novoSku;
    alvo.produto.descricao = produtoNovo.descricao ?? alvo.produto.descricao;

    const { error: upErr } = await sb
      .from("siso_pedidos")
      .update({ payload_original: payload })
      .eq("id", pedidoId);
    if (upErr) throw upErr;

    // 5. Reprocessa nativo (mesmo caminho do webhook, com o payload corrigido)
    let galpaoId = pedido.separacao_galpao_id as string | null;
    if (!galpaoId) {
      const { data: pref } = await sb
        .from("siso_empresa_galpoes_preferenciais")
        .select("galpao_id")
        .eq("empresa_id", empresaId)
        .limit(1)
        .maybeSingle();
      galpaoId = pref?.galpao_id ?? null;
    }
    if (!galpaoId) {
      return NextResponse.json(
        { error: "Não foi possível resolver o galpão do pedido" },
        { status: 422 },
      );
    }
    const { data: galpaoRow } = await sb
      .from("siso_galpoes")
      .select("nome")
      .eq("id", galpaoId)
      .maybeSingle();
    const galpaoNome = galpaoRow?.nome ?? "CWB";

    const { data: log } = await sb
      .from("siso_webhook_logs")
      .select("id")
      .eq("tiny_pedido_id", pedidoId)
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const webhookLogId = log?.id ?? crypto.randomUUID();

    const result = await processWebhookWms({
      webhookLogId,
      pedido: payload,
      empresaOrigemId: empresaId,
      galpaoOrigemId: galpaoId,
      galpaoOrigemNome: galpaoNome,
    });

    logger.info("pedidos.definir-sku", "SKU definido + pedido reprocessado", {
      pedidoId,
      itemId,
      sku: novoSku,
      tinyProdutoId: tinyId,
      novoStatus: result.status,
      sugestao: result.sugestao,
    });

    return NextResponse.json({
      ok: true,
      sku: novoSku,
      tiny_produto_id: tinyId,
      pedido: { status: result.status, sugestao: result.sugestao },
    });
  } catch (err) {
    logger.error("pedidos.definir-sku", "Erro ao definir SKU", {
      pedidoId,
      itemId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno ao definir SKU" }, { status: 500 });
  }
}
