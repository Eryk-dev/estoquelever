import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
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
  // Admin não precisa de galpaoId — usamos o galpao_id da própria realocação

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
        quantidade, status
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
      .select("id, pedido_id, produto_id, sku, quantidade_pedida")
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

    // 3D: empréstimo deixou de existir. Saída sempre nf_venda taggeada com a
    // empresa vendedora (origem do pedido). Mantemos empresa_dona_id da realoc
    // apenas como ownership lógica do pedido — não chave de estoque.
    const empresaVendedoraId = pedido.empresa_origem_id as string | null;
    const produtoWmsId = await resolverProdutoWms(
      realoc.empresa_dona_id,
      String(item.produto_id),
    );

    const mov = await inserirMovimentacao({
      tripla: {
        produto_id: produtoWmsId,
        galpao_id: realoc.galpao_id,
        localizacao_id: realoc.localizacao_id,
      },
      tipo: "S",
      qty: realoc.quantidade,
      origem_tipo: "nf_venda",
      origem_detalhes: {
        pedido_id_tiny: pedido.id,
        pedido_numero: pedido.numero,
        pedido_item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        contexto: "realocacao",
      },
      empresa_vendedora_id: empresaVendedoraId,
      motivo: `Picking pedido #${pedido.numero} — realocação`,
      usuario_id: session.id,
    });

    // Tabela ponte: 1 link por mov de saída de realocação picada.
    const { error: linkErr } = await supabase
      .from("siso_pedido_item_mov_links")
      .insert({
        pedido_item_id: Number(realoc.pedido_item_id),
        realocacao_id: realoc.id,
        mov_id: mov.id,
        qty: Number(realoc.quantidade),
        tipo_link: "saida",
      });
    if (linkErr) {
      logger.logError({
        error: linkErr,
        source: "separacao-marcar-realocacao",
        message: "Falhou criar link da mov",
        category: "database",
        requestPath: "/api/wms/separacao/marcar-realocacao",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, mov_id: mov.id },
      });
      return NextResponse.json({ error: "erro persistindo link" }, { status: 500 });
    }

    const nowIso = new Date().toISOString();
    // C4: race-check via .eq("status","aguardando_picking") — se outro op
    // picou primeiro (0 rows affected), rollback (estornar mov + delete bridge)
    // e retorna 409 realocacao_ja_picada.
    const { data: claimed, error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({
        status: "picado",
        picado_em: nowIso,
        picado_por: session.id,
        mov_saida_id: mov.id,
      })
      .eq("id", realoc.id)
      .eq("status", "aguardando_picking")
      .select("id");

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-marcar-realocacao",
        message: "Falhou update realocação após mov",
        category: "database",
        requestPath: "/api/wms/separacao/marcar-realocacao",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, mov_id: mov.id },
      });
      return NextResponse.json({ error: "erro persistindo realocação" }, { status: 500 });
    }

    if (!claimed || claimed.length === 0) {
      // Race: rollback (estornar mov + delete bridge link)
      try {
        await estornarMovimentacao({
          mov_id: mov.id,
          usuario_id: session.id,
          motivo: "Race condition — outro operador picou primeiro",
        });
      } catch (e: unknown) {
        logger.warn("separacao-marcar-realocacao", "rollback estorno falhou", {
          error: (e as Error).message,
        });
      }
      await supabase
        .from("siso_pedido_item_mov_links")
        .delete()
        .eq("mov_id", mov.id);
      return NextResponse.json(
        {
          error: "realocacao_ja_picada",
          message: "Outro operador picou primeiro — atualize a tela",
        },
        { status: 409 },
      );
    }

    // I9: acumula qty_pega atomicamente via RPC (substitui RMW)
    await supabase.rpc("wms_acumular_qty_pega", {
      p_item_id: item.id,
      p_delta: Number(realoc.quantidade),
    });

    await registrarEvento({
      pedidoId: pedido.id,
      evento: "realocacao_picada",
      detalhes: {
        item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        quantidade: realoc.quantidade,
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
      requestPath: "/api/wms/separacao/marcar-realocacao",
      requestMethod: "POST",
      metadata: { realocacao_id: body?.realocacao_id },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
