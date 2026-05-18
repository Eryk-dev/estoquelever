import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import { resolverProdutoWms, resolverLocalizacaoWms } from "@/lib/separacao/wms-mapping";

/**
 * POST /api/separacao/marcar-item
 * Body: { pedido_item_id, marcado: boolean }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.pedido_item_id || typeof body.marcado !== "boolean") {
    return NextResponse.json(
      { error: "'pedido_item_id' e 'marcado' obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_item_id, marcado } = body as {
    pedido_item_id: number | string;
    marcado: boolean;
  };

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, separacao_parcial, mov_saida_id",
      )
      .eq("id", pedido_item_id)
      .single();
    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }
    if (item.separacao_parcial) {
      return NextResponse.json(
        { error: "item está em parcial — use /desfazer-parcial antes" },
        { status: 409 },
      );
    }

    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .eq("id", item.pedido_id)
      .single();
    if (!pedido) {
      return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
    }
    const ALLOWED = ["em_separacao", "aguardando_separacao", "aguardando_compra"];
    if (!ALLOWED.includes(pedido.status_separacao ?? "")) {
      return NextResponse.json(
        { error: `pedido status ${pedido.status_separacao} não permite marcar` },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedido.empresa_origem_id as string | null;
    const galpaoId = pedido.separacao_galpao_id as string | null;
    const nowIso = new Date().toISOString();

    if (marcado) {
      let movSaidaId: string | null = null;
      if (empresaOrigemId && galpaoId) {
        try {
          const produtoWmsId = await resolverProdutoWms(
            empresaOrigemId,
            String(item.produto_id),
          );
          const { data: estoque } = await supabase
            .from("siso_pedido_item_estoques")
            .select("localizacao")
            .eq("pedido_id", pedido.id)
            .eq("produto_id", item.produto_id)
            .eq("empresa_id", empresaOrigemId)
            .maybeSingle();
          const locId = await resolverLocalizacaoWms(galpaoId, (estoque?.localizacao as string | null | undefined) ?? null);

          const mov = await inserirMovimentacao({
            quadrupla: {
              produto_id: produtoWmsId,
              empresa_dona_id: empresaOrigemId,
              galpao_id: galpaoId,
              localizacao_id: locId,
            },
            tipo: "S",
            qty: item.quantidade_pedida,
            origem_tipo: "nf_venda",
            origem_id: `pedido:${pedido.id}`,
            origem_detalhes: {
              pedido_numero: pedido.numero,
              pedido_item_id: item.id,
              sku: item.sku,
              contexto: "checkbox",
            },
            observacoes: `Picking pedido #${pedido.numero} — checkbox completo`,
            usuario_id: session.id,
          });
          movSaidaId = mov.id;
        } catch (wmsErr) {
          logger.warn("separacao-marcar-item", "Mov WMS skipped", {
            error: wmsErr instanceof Error ? wmsErr.message : String(wmsErr),
            pedido_item_id,
          });
        }
      }

      const { data: updated, error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: true,
          separacao_marcado_em: nowIso,
          quantidade_pega: item.quantidade_pedida,
          mov_saida_id: movSaidaId,
        })
        .eq("id", item.id)
        .select()
        .single();
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
      return NextResponse.json(updated);
    } else {
      if (item.mov_saida_id) {
        try {
          await estornarMovimentacao({
            mov_id: item.mov_saida_id,
            usuario_id: session.id,
            observacoes: "Desmarcar checkbox",
          });
        } catch (estornoErr) {
          logger.warn("separacao-marcar-item", "Estorno WMS falhou", {
            error: estornoErr instanceof Error ? estornoErr.message : String(estornoErr),
            mov_id: item.mov_saida_id,
          });
        }
      }
      const { data: updated, error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: false,
          separacao_marcado_em: null,
          quantidade_pega: null,
          mov_saida_id: null,
        })
        .eq("id", item.id)
        .select()
        .single();
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
      return NextResponse.json(updated);
    }
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-marcar-item",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/wms/separacao/marcar-item",
      requestMethod: "POST",
      metadata: { pedido_item_id, marcado },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
