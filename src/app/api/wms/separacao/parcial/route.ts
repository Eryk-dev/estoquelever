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
 *
 * Modo dual:
 *  - Item:       { pedido_item_id, quantidade_pega, loc_zerou }
 *  - Realocação: { realocacao_id, quantidade_pega, loc_zerou }
 *
 * Headers: X-Session-Id
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  // Admin não precisa de galpaoId — derivamos do próprio pedido abaixo

  const body = await request.json().catch(() => null);

  const isRealocacaoMode = body && typeof body.realocacao_id === "string";
  const isItemMode =
    body &&
    (typeof body.pedido_item_id === "number" ||
      typeof body.pedido_item_id === "string");

  if (!isRealocacaoMode && !isItemMode) {
    return NextResponse.json(
      { error: "campo 'pedido_item_id' ou 'realocacao_id' obrigatório" },
      { status: 400 },
    );
  }

  if (
    typeof body.quantidade_pega !== "number" ||
    body.quantidade_pega < 0 ||
    !Number.isInteger(body.quantidade_pega) ||
    typeof body.loc_zerou !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "campos 'quantidade_pega' (int>=0) e 'loc_zerou' (bool) obrigatórios",
      },
      { status: 400 },
    );
  }

  const { quantidade_pega, loc_zerou } = body as {
    quantidade_pega: number;
    loc_zerou: boolean;
  };

  const supabase = createServiceClient();

  if (isItemMode) {
    return processarParcialItem(
      supabase,
      session,
      body.pedido_item_id,
      quantidade_pega,
      loc_zerou,
    );
  }
  return processarParcialRealocacao(
    supabase,
    session,
    body.realocacao_id,
    quantidade_pega,
    loc_zerou,
  );
}

async function processarParcialItem(
  supabase: ReturnType<typeof createServiceClient>,
  session: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  pedido_item_id: number | string,
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
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
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", empresaOrigemId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locOriginalId)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);
    const reservadoWms = Number(estoqueWms?.reservado ?? 0);
    const disponivelWms = Number(estoqueWms?.disponivel ?? saldoWms - reservadoWms);

    // Blindagem: o ledger valida `reservado <= saldo_posterior` na RPC e
    // rejeita a mov com erro genérico. Detectamos aqui pra devolver 409
    // explicando ao operador que a posição tem reserva ativa de outro pedido.
    if (quantidade_pega > 0 && disponivelWms < quantidade_pega) {
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado ${reservadoWms}, disponível ${disponivelWms}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoWms,
          disponivel: disponivelWms,
          quantidade_pega,
        },
        { status: 409 },
      );
    }

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
        requestPath: "/api/wms/separacao/parcial",
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
        requestPath: "/api/wms/separacao/parcial",
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
      requestPath: "/api/wms/separacao/parcial",
      requestMethod: "POST",
      metadata: { pedido_item_id, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}

async function processarParcialRealocacao(
  supabase: ReturnType<typeof createServiceClient>,
  session: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  realocacao_id: string,
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
  try {
    // 1. Busca realocação
    const { data: realoc, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select(`
        id, pedido_item_id, empresa_dona_id, galpao_id, localizacao_id,
        quantidade, is_emprestimo, empresa_devedora_id, status
      `)
      .eq("id", realocacao_id)
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
    if (quantidade_pega > realoc.quantidade) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder ${realoc.quantidade}` },
        { status: 400 },
      );
    }

    // 2. Busca item pai e pedido
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

    // 3. Resolve produto WMS (na empresa dona da realoc — pode ser empréstimo)
    const produtoWmsId = await resolverProdutoWms(
      realoc.empresa_dona_id,
      String(item.produto_id),
    );

    // 4. Lê saldo atual
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", realoc.empresa_dona_id)
      .eq("galpao_id", realoc.galpao_id)
      .eq("localizacao_id", realoc.localizacao_id)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);
    const reservadoWms = Number(estoqueWms?.reservado ?? 0);
    const disponivelWms = Number(estoqueWms?.disponivel ?? saldoWms - reservadoWms);

    if (quantidade_pega > 0 && disponivelWms < quantidade_pega) {
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado ${reservadoWms}, disponível ${disponivelWms}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoWms,
          disponivel: disponivelWms,
          quantidade_pega,
        },
        { status: 409 },
      );
    }

    // 5. Gera mov S (qty pega) — origem emprestimo OU nf_venda
    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      const mov = await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoWmsId,
          empresa_dona_id: realoc.empresa_dona_id,
          galpao_id: realoc.galpao_id,
          localizacao_id: realoc.localizacao_id,
        },
        tipo: "S",
        qty: quantidade_pega,
        origem_tipo: realoc.is_emprestimo ? "emprestimo" : "nf_venda",
        origem_id: `pedido:${pedido.id}`,
        origem_detalhes: {
          pedido_numero: pedido.numero,
          pedido_item_id: item.id,
          realocacao_id: realoc.id,
          sku: item.sku,
          contexto: "realocacao_parcial",
        },
        emprestimo_devedora_id: realoc.is_emprestimo
          ? realoc.empresa_devedora_id ?? undefined
          : undefined,
        observacoes: realoc.is_emprestimo
          ? `Picking parcial pedido #${pedido.numero} — empréstimo`
          : `Picking parcial pedido #${pedido.numero} — realocação`,
        usuario_id: session.id,
      });
      movSaidaId = mov.id;
    }

    // 6. Gera mov de ajuste se loc zerou
    let movAjusteId: string | null = null;
    if (loc_zerou) {
      const delta = saldoWms - quantidade_pega;
      if (delta > 0) {
        const movAj = await inserirMovimentacao({
          quadrupla: {
            produto_id: produtoWmsId,
            empresa_dona_id: realoc.empresa_dona_id,
            galpao_id: realoc.galpao_id,
            localizacao_id: realoc.localizacao_id,
          },
          tipo: "S",
          qty: delta,
          origem_tipo: "ajuste_pick_zerou",
          origem_id: `pedido:${pedido.id}`,
          origem_detalhes: {
            pedido_numero: pedido.numero,
            pedido_item_id: item.id,
            realocacao_id: realoc.id,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou na realocação — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    // 7. Atualiza realocação: parcial ou picado
    const qtyResidual = realoc.quantidade - quantidade_pega;
    const isCompleto = qtyResidual <= 0;
    const nowIso = new Date().toISOString();

    const { error: updErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({
        status: isCompleto ? "picado" : "picado_parcial",
        quantidade_pega,
        parcial: !isCompleto,
        parcial_motivo: !isCompleto
          ? loc_zerou ? "cascade_loc_zerou" : "cascade_parcial"
          : null,
        parcial_em: !isCompleto ? nowIso : null,
        parcial_por: !isCompleto ? session.id : null,
        picado_em: isCompleto ? nowIso : null,
        picado_por: isCompleto ? session.id : null,
        mov_saida_id: movSaidaId,
        mov_ajuste_loc_zerou_id: movAjusteId,
      })
      .eq("id", realoc.id);

    if (updErr) {
      logger.logError({
        error: updErr,
        source: "separacao-parcial-realoc",
        message: "Falhou update realocação",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, movSaidaId, movAjusteId },
      });
      return NextResponse.json({ error: "erro persistindo realocação" }, { status: 500 });
    }

    // 8. Acumula no item pai
    const novaQtyPaiPega = (item.quantidade_pega ?? 0) + quantidade_pega;
    await supabase
      .from("siso_pedido_itens")
      .update({ quantidade_pega: novaQtyPaiPega })
      .eq("id", item.id);

    // 9. Evento histórico
    await registrarEvento({
      pedidoId: pedido.id,
      evento: isCompleto ? "realocacao_picada" : "realocacao_parcial",
      detalhes: {
        item_id: item.id,
        realocacao_id: realoc.id,
        sku: item.sku,
        quantidade_pega,
        quantidade_sugerida: realoc.quantidade,
        is_emprestimo: realoc.is_emprestimo,
        loc_zerou,
        delta_ajuste: movAjusteId ? saldoWms - quantidade_pega : 0,
      },
      usuarioId: session.id,
    });

    if (isCompleto) {
      return NextResponse.json({ status: "completo" });
    }

    // 10. Cascade — disparado em Task 4
    return NextResponse.json({ status: "completo" }); // STUB — substituído em Task 4
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-parcial-realoc",
      message: "Erro inesperado em parcial realocação",
      category: "unknown",
      requestPath: "/api/wms/separacao/parcial",
      requestMethod: "POST",
      metadata: { realocacao_id, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
