import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";

/**
 * POST /api/separacao/marcar-realocacao
 * Body: { realocacao_id }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!session.galpaoId) {
    return NextResponse.json({ error: "admin não pode marcar realocação" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.realocacao_id) {
    return NextResponse.json(
      { error: "'realocacao_id' obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const { data: realoc, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select(`
        id, pedido_item_id, empresa_dona_id, galpao_id, localizacao_id,
        quantidade, is_emprestimo, empresa_devedora_id, status
      `)
      .eq("id", body.realocacao_id)
      .single();

    if (realocErr || !realoc) {
      return NextResponse.json({ error: "realocação não encontrada" }, { status: 404 });
    }
    if (realoc.status !== "aguardando_picking") {
      return NextResponse.json(
        { error: `realocação não está aguardando picking (atual: ${realoc.status})` },
        { status: 409 },
      );
    }

    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega")
      .eq("id", realoc.pedido_item_id)
      .single();
    if (!item) {
      return NextResponse.json({ error: "item pai não encontrado" }, { status: 404 });
    }

    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id")
      .eq("id", item.pedido_id)
      .single();
    if (!pedido) {
      return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
    }

    const produtoWmsId = await resolverProdutoWms(
      realoc.empresa_dona_id,
      String(item.produto_id),
    );

    const mov = await inserirMovimentacao({
      quadrupla: {
        produto_id: produtoWmsId,
        empresa_dona_id: realoc.empresa_dona_id,
        galpao_id: realoc.galpao_id,
        localizacao_id: realoc.localizacao_id,
      },
      tipo: "S",
      qty: realoc.quantidade,
      origem_tipo: realoc.is_emprestimo ? "emprestimo" : "nf_venda",
      origem_id: `pedido:${pedido.id}`,
      origem_detalhes: {
        pedido_numero: pedido.numero,
        pedido_item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        contexto: "realocacao",
      },
      emprestimo_devedora_id: realoc.is_emprestimo
        ? realoc.empresa_devedora_id ?? undefined
        : undefined,
      observacoes: realoc.is_emprestimo
        ? `Picking pedido #${pedido.numero} — empréstimo`
        : `Picking pedido #${pedido.numero} — realocação`,
      usuario_id: session.id,
    });

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({
        status: "picado",
        picado_em: nowIso,
        picado_por: session.id,
        mov_saida_id: mov.id,
      })
      .eq("id", realoc.id);

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-marcar-realocacao",
        message: "Falhou update realocação após mov",
        category: "database",
        requestPath: "/api/separacao/marcar-realocacao",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, mov_id: mov.id },
      });
      return NextResponse.json({ error: "erro persistindo realocação" }, { status: 500 });
    }

    const novaQty = (item.quantidade_pega ?? 0) + realoc.quantidade;
    await supabase
      .from("siso_pedido_itens")
      .update({ quantidade_pega: novaQty })
      .eq("id", item.id);

    await registrarEvento({
      pedidoId: pedido.id,
      evento: "realocacao_picada",
      detalhes: {
        item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        quantidade: realoc.quantidade,
        is_emprestimo: realoc.is_emprestimo,
      },
      usuarioId: session.id,
    });

    return NextResponse.json({ status: "picado", mov_id: mov.id });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-marcar-realocacao",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/separacao/marcar-realocacao",
      requestMethod: "POST",
      metadata: { realocacao_id: body?.realocacao_id },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
