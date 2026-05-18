import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverProdutoWms, resolverLocalizacaoWms } from "@/lib/separacao/wms-mapping";
import { resolverRealocacao } from "@/lib/separacao/realocacao-resolver";

/**
 * POST /api/separacao/parcial
 * Body: { pedido_item_id: number, quantidade_pega: int, loc_zerou: bool }
 * Headers: X-Session-Id
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  // Admin não precisa de galpaoId — derivamos do próprio pedido abaixo

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_item_id ||
    typeof body.quantidade_pega !== "number" ||
    body.quantidade_pega < 0 ||
    !Number.isInteger(body.quantidade_pega) ||
    typeof body.loc_zerou !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "campos 'pedido_item_id', 'quantidade_pega' (int>=0), 'loc_zerou' (bool) obrigatórios",
      },
      { status: 400 },
    );
  }

  const { pedido_item_id, quantidade_pega, loc_zerou } = body as {
    pedido_item_id: number | string;
    quantidade_pega: number;
    loc_zerou: boolean;
  };

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, separacao_marcado, separacao_parcial",
      )
      .eq("id", pedido_item_id)
      .single();

    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }

    if (item.separacao_marcado || item.separacao_parcial) {
      return NextResponse.json(
        { error: "item já processado (marcado ou parcial)" },
        { status: 409 },
      );
    }

    if (quantidade_pega > item.quantidade_pedida) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder quantidade_pedida (${item.quantidade_pedida})` },
        { status: 400 },
      );
    }

    const { data: pedido, error: pedidoErr } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .eq("id", item.pedido_id)
      .single();

    if (pedidoErr || !pedido) {
      return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
    }
    if (pedido.status_separacao !== "em_separacao") {
      return NextResponse.json(
        { error: `pedido não está em_separacao (atual: ${pedido.status_separacao})` },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedido.empresa_origem_id as string | null;
    const galpaoId = (pedido.separacao_galpao_id as string | null) ?? session.galpaoId;
    if (!empresaOrigemId || !galpaoId) {
      return NextResponse.json({ error: "pedido sem empresa/galpão" }, { status: 400 });
    }

    const produtoWmsId = await resolverProdutoWms(empresaOrigemId, String(item.produto_id));

    const { data: estoque } = await supabase
      .from("siso_pedido_item_estoques")
      .select("localizacao, saldo")
      .eq("pedido_id", item.pedido_id)
      .eq("produto_id", item.produto_id)
      .eq("empresa_id", empresaOrigemId)
      .maybeSingle();

    const locCodigo = (estoque?.localizacao as string | null | undefined) ?? null;
    const locOriginalId = await resolverLocalizacaoWms(galpaoId, locCodigo);

    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", empresaOrigemId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locOriginalId)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);

    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      const mov = await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoWmsId,
          empresa_dona_id: empresaOrigemId,
          galpao_id: galpaoId,
          localizacao_id: locOriginalId,
        },
        tipo: "S",
        qty: quantidade_pega,
        origem_tipo: "nf_venda",
        origem_id: `pedido:${pedido.id}`,
        origem_detalhes: {
          pedido_numero: pedido.numero,
          pedido_item_id: item.id,
          sku: item.sku,
          contexto: "parcial",
        },
        observacoes: `Picking parcial pedido #${pedido.numero}`,
        usuario_id: session.id,
      });
      movSaidaId = mov.id;
    }

    let movAjusteId: string | null = null;
    if (loc_zerou) {
      const delta = saldoWms - quantidade_pega;
      if (delta > 0) {
        const movAj = await inserirMovimentacao({
          quadrupla: {
            produto_id: produtoWmsId,
            empresa_dona_id: empresaOrigemId,
            galpao_id: galpaoId,
            localizacao_id: locOriginalId,
          },
          tipo: "S",
          qty: delta,
          origem_tipo: "ajuste_pick_zerou",
          origem_id: `pedido:${pedido.id}`,
          origem_detalhes: {
            pedido_numero: pedido.numero,
            pedido_item_id: item.id,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou no picking — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        quantidade_pega,
        separacao_parcial: true,
        parcial_motivo: loc_zerou ? "loc_zerou" : "qty_diferente",
        parcial_em: nowIso,
        parcial_por: session.id,
        separacao_marcado: true,
        separacao_marcado_em: nowIso,
        mov_saida_id: movSaidaId,
        mov_ajuste_loc_zerou_id: movAjusteId,
      })
      .eq("id", item.id);

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-parcial",
        message: "Falhou update pedido_itens após movs",
        category: "database",
        requestPath: "/api/separacao/parcial",
        requestMethod: "POST",
        metadata: { pedido_item_id, movSaidaId, movAjusteId },
      });
      return NextResponse.json({ error: "erro persistindo parcial" }, { status: 500 });
    }

    await registrarEvento({
      pedidoId: pedido.id,
      evento: "parcial_loc_zerou",
      detalhes: {
        item_id: item.id,
        sku: item.sku,
        quantidade_pega,
        quantidade_pedida: item.quantidade_pedida,
        loc_codigo: locCodigo,
        loc_zerou,
        delta_ajuste: movAjusteId ? saldoWms - quantidade_pega : 0,
      },
      usuarioId: session.id,
    });

    const qtyResidual = item.quantidade_pedida - quantidade_pega;
    if (qtyResidual <= 0) {
      return NextResponse.json({ status: "completo" });
    }

    const resolver = await resolverRealocacao({
      produto_id: produtoWmsId,
      empresa_origem_id: empresaOrigemId,
      galpao_id: galpaoId,
      localizacao_id_original: locOriginalId,
      qty_residual: qtyResidual,
    });

    if (resolver.status === "sem_cobertura") {
      await supabase
        .from("siso_pedidos")
        .update({ status_separacao: "pendente_realocacao" })
        .eq("id", pedido.id);

      await registrarEvento({
        pedidoId: pedido.id,
        evento: "realocacao_sem_cobertura_galpao",
        detalhes: { item_id: item.id, sku: item.sku, qty_residual: qtyResidual },
        usuarioId: session.id,
      });

      return NextResponse.json({
        status: "aguardando_supervisor",
        motivo: "sem_cobertura_total",
      });
    }

    const rows = resolver.realocacoes.map((r) => ({
      pedido_item_id: item.id,
      empresa_dona_id: r.empresa_dona_id,
      galpao_id: galpaoId,
      localizacao_id: r.localizacao_id,
      quantidade: r.quantidade,
      is_emprestimo: r.is_emprestimo,
      empresa_devedora_id: r.empresa_devedora_id,
      motivo: "loc_zerou",
      criado_por: session.id,
    }));

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(rows)
      .select("id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial",
        message: "Falhou criar realocações",
        category: "database",
        requestPath: "/api/separacao/parcial",
        requestMethod: "POST",
        metadata: { pedido_item_id, rows },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    return NextResponse.json({
      status: "realocado",
      realocacoes: (criadas ?? []).map((c, i) => ({
        id: c.id,
        empresa_dona_id: c.empresa_dona_id,
        localizacao_id: c.localizacao_id,
        localizacao_codigo: resolver.realocacoes[i].localizacao_codigo,
        quantidade: c.quantidade,
        is_emprestimo: c.is_emprestimo,
      })),
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-parcial",
      message: "Erro inesperado em parcial",
      category: "unknown",
      requestPath: "/api/separacao/parcial",
      requestMethod: "POST",
      metadata: { pedido_item_id, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
