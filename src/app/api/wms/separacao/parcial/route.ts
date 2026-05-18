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
  // Modo item aceita pedido_item_id (single, compat) OU pedido_item_ids (array,
  // pra fluxo de wave picking onde o mesmo SKU aparece em pedidos diferentes
  // consolidados numa única linha do checklist).
  const isItemMode =
    body &&
    (typeof body.pedido_item_id === "number" ||
      typeof body.pedido_item_id === "string" ||
      (Array.isArray(body.pedido_item_ids) && body.pedido_item_ids.length > 0));

  if (!isRealocacaoMode && !isItemMode) {
    return NextResponse.json(
      {
        error:
          "campo 'pedido_item_id' (compat) OU 'pedido_item_ids' (array) OU 'realocacao_id' obrigatório",
      },
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
    const ids: (number | string)[] = Array.isArray(body.pedido_item_ids)
      ? body.pedido_item_ids
      : [body.pedido_item_id];
    return processarParcialItem(supabase, session, ids, quantidade_pega, loc_zerou);
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
  pedido_item_ids: (number | string)[],
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
  try {
    // 1. Carrega TODOS os items na ordem de id (FCFS pra distribuição)
    const { data: itemsRaw, error: itemsErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, separacao_marcado, separacao_parcial",
      )
      .in("id", pedido_item_ids)
      .order("id", { ascending: true });

    if (itemsErr || !itemsRaw || itemsRaw.length === 0) {
      return NextResponse.json({ error: "item(s) não encontrado(s)" }, { status: 404 });
    }

    if (itemsRaw.length !== pedido_item_ids.length) {
      return NextResponse.json(
        { error: "alguns item_ids não foram encontrados" },
        { status: 404 },
      );
    }

    // 2. Valida: nenhum já processado
    const jaProcessado = itemsRaw.find(
      (it) => it.separacao_marcado || it.separacao_parcial,
    );
    if (jaProcessado) {
      return NextResponse.json(
        { error: `item ${jaProcessado.id} já processado (marcado ou parcial)` },
        { status: 409 },
      );
    }

    // 3. Valida: todos com o mesmo produto_id (consolidação só faz sentido pro mesmo SKU)
    const produtoIdSet = new Set(itemsRaw.map((it) => String(it.produto_id)));
    if (produtoIdSet.size > 1) {
      return NextResponse.json(
        { error: "items devem ter o mesmo produto_id" },
        { status: 400 },
      );
    }

    const totalPedido = itemsRaw.reduce(
      (s, it) => s + Number(it.quantidade_pedida),
      0,
    );
    if (quantidade_pega > totalPedido) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder o total pedido (${totalPedido})` },
        { status: 400 },
      );
    }

    // 4. Carrega pedidos relacionados — todos devem estar em_separacao e
    //    no mesmo galpão / mesma empresa origem (invariante do wave picking)
    const pedidoIds = [...new Set(itemsRaw.map((it) => it.pedido_id))];
    const { data: pedidos, error: pedidosErr } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .in("id", pedidoIds);

    if (pedidosErr || !pedidos || pedidos.length !== pedidoIds.length) {
      return NextResponse.json({ error: "pedido(s) não encontrado(s)" }, { status: 404 });
    }

    const naoEmSeparacao = pedidos.find((p) => p.status_separacao !== "em_separacao");
    if (naoEmSeparacao) {
      return NextResponse.json(
        {
          error: `pedido ${naoEmSeparacao.numero} não está em_separacao (atual: ${naoEmSeparacao.status_separacao})`,
        },
        { status: 400 },
      );
    }

    const empresasSet = new Set(pedidos.map((p) => p.empresa_origem_id));
    const galpoesSet = new Set(
      pedidos.map((p) => p.separacao_galpao_id ?? session.galpaoId ?? null),
    );
    if (empresasSet.size > 1 || galpoesSet.size > 1) {
      return NextResponse.json(
        { error: "items devem estar no mesmo galpão e empresa origem" },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedidos[0].empresa_origem_id as string | null;
    const galpaoId =
      (pedidos[0].separacao_galpao_id as string | null) ?? session.galpaoId;
    if (!empresaOrigemId || !galpaoId) {
      return NextResponse.json({ error: "pedido sem empresa/galpão" }, { status: 400 });
    }

    const pedidoById = new Map(pedidos.map((p) => [p.id, p]));
    const primeiroItem = itemsRaw[0];
    const primeiroPedido = pedidoById.get(primeiroItem.pedido_id)!;

    const produtoTinyId = String(primeiroItem.produto_id);
    const produtoWmsId = await resolverProdutoWms(empresaOrigemId, produtoTinyId);

    // 5. Loc original — usa a do primeiro item (no wave picking, todos compartilham a mesma loc consolidada)
    const { data: estoque } = await supabase
      .from("siso_pedido_item_estoques")
      .select("localizacao")
      .eq("pedido_id", primeiroItem.pedido_id)
      .eq("produto_id", primeiroItem.produto_id)
      .eq("empresa_id", empresaOrigemId)
      .maybeSingle();

    const locCodigo = (estoque?.localizacao as string | null | undefined) ?? null;
    const locOriginalId = await resolverLocalizacaoWms(galpaoId, locCodigo);

    // 6. Saldo / reservado
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

    // 7. Gera mov S única (qty_pega total) e mov ajuste única — ambas vinculadas ao primeiro pedido,
    //    com lista completa de items cobertos em origem_detalhes pra rastreabilidade.
    const itemIdsList = itemsRaw.map((it) => Number(it.id));

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
        origem_id: `pedido:${primeiroPedido.id}`,
        origem_detalhes: {
          pedido_numero: primeiroPedido.numero,
          pedido_item_ids: itemIdsList,
          sku: primeiroItem.sku,
          contexto: itemsRaw.length > 1 ? "parcial_consolidado" : "parcial",
        },
        observacoes:
          itemsRaw.length > 1
            ? `Picking parcial wave — ${itemsRaw.length} items (pedido #${primeiroPedido.numero}…)`
            : `Picking parcial pedido #${primeiroPedido.numero}`,
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
          origem_id: `pedido:${primeiroPedido.id}`,
          origem_detalhes: {
            pedido_numero: primeiroPedido.numero,
            pedido_item_ids: itemIdsList,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou no picking — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    // 8. Distribui qty_pega entre items em ordem (first-come-first-served) e
    //    coleta items residuais pra cascade.
    const nowIso = new Date().toISOString();
    let qtyRestante = quantidade_pega;
    const itemUpdates: Array<{
      item: typeof itemsRaw[number];
      qty_para_este: number;
      qty_residual: number;
      pedido_id: string;
    }> = [];

    for (const it of itemsRaw) {
      const pedidaItem = Number(it.quantidade_pedida);
      const qtyParaEste = Math.min(pedidaItem, qtyRestante);
      qtyRestante -= qtyParaEste;
      itemUpdates.push({
        item: it,
        qty_para_este: qtyParaEste,
        qty_residual: pedidaItem - qtyParaEste,
        pedido_id: it.pedido_id,
      });
    }

    // 9. Update de cada item conforme distribuição
    //    Movs ficam vinculadas SÓ ao primeiro item que recebeu qty (ou ao primeiro
    //    item residual se ninguém recebeu — caso qty_pega=0 + loc_zerou).
    const indexPrimeiroBeneficiado =
      itemUpdates.findIndex((u) => u.qty_para_este > 0) >= 0
        ? itemUpdates.findIndex((u) => u.qty_para_este > 0)
        : 0;

    for (let i = 0; i < itemUpdates.length; i++) {
      const u = itemUpdates[i];
      const { item: it, qty_para_este, qty_residual } = u;
      const ehBeneficiario = i === indexPrimeiroBeneficiado;
      const isCompleto = qty_residual === 0;

      // Decisão de marcar/parcial:
      // - qty_para_este == pedida: completo (marcado=true, parcial=false)
      // - qty_para_este > 0 mas < pedida: parcial (marcado=true, parcial=true)
      // - qty_para_este == 0 AND loc_zerou: parcial residual completo (marcado=true, parcial=true, qty=0)
      // - qty_para_este == 0 AND NOT loc_zerou: NÃO marca (operador continua a fazer)
      const deveMarcar = qty_para_este > 0 || loc_zerou;
      if (!deveMarcar) continue;

      const isParcial = !isCompleto;
      const { error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          quantidade_pega: qty_para_este,
          separacao_parcial: isParcial,
          parcial_motivo: isParcial ? (loc_zerou ? "loc_zerou" : "qty_diferente") : null,
          parcial_em: isParcial ? nowIso : null,
          parcial_por: isParcial ? session.id : null,
          separacao_marcado: true,
          separacao_marcado_em: nowIso,
          mov_saida_id: ehBeneficiario ? movSaidaId : null,
          mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,
        })
        .eq("id", it.id);

      if (updErr) {
        logger.logError({
          error: updErr,
          source: "separacao-parcial",
          message: "Falhou update pedido_itens após movs",
          category: "database",
          requestPath: "/api/wms/separacao/parcial",
          requestMethod: "POST",
          metadata: { pedido_item_id: it.id, movSaidaId, movAjusteId },
        });
        return NextResponse.json({ error: "erro persistindo parcial" }, { status: 500 });
      }

      await registrarEvento({
        pedidoId: it.pedido_id,
        evento: "parcial_loc_zerou",
        detalhes: {
          item_id: it.id,
          sku: it.sku,
          quantidade_pega: qty_para_este,
          quantidade_pedida: Number(it.quantidade_pedida),
          loc_codigo: locCodigo,
          loc_zerou,
          delta_ajuste: ehBeneficiario && movAjusteId ? saldoWms - quantidade_pega : 0,
          wave_consolidado: itemsRaw.length > 1,
        },
        usuarioId: session.id,
      });
    }

    // 10. Cascade: pra cada item com residual, busca outra loc.
    //     Cascade só faz sentido se loc_zerou=true (caso contrário operador
    //     volta a picar normalmente o item — não há "esgotou" envolvido).
    const itemsResiduais = itemUpdates.filter((u) => u.qty_residual > 0);

    if (itemsResiduais.length === 0) {
      return NextResponse.json({ status: "completo" });
    }

    if (!loc_zerou) {
      // Operador pegou menos que pedido mas não zerou a loc — items residuais
      // NÃO foram marcados (deveMarcar=false acima), continuam a fazer no checklist.
      // Não roda cascade.
      return NextResponse.json({
        status: "completo",
        items_marcados: itemUpdates.filter((u) => u.qty_para_este > 0).length,
        items_residuais_a_fazer: itemsResiduais.length,
      });
    }

    // loc_zerou=true: monta exclusion list (loc original + todas as realocs
    // anteriores dos items envolvidos)
    const itemIdsResiduais = itemsResiduais.map((u) => Number(u.item.id));
    const { data: realocsExistentes } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("localizacao_id")
      .in("pedido_item_id", itemIdsResiduais);

    const localizacoes_excluir = Array.from(
      new Set([
        locOriginalId,
        ...((realocsExistentes ?? []).map((r) => r.localizacao_id as string)),
      ]),
    );

    // Roda cascade UMA vez pro total residual agregado, distribui as
    // realocações encontradas entre os items residuais (first-come-first-served).
    const totalResidual = itemsResiduais.reduce((s, u) => s + u.qty_residual, 0);

    const resolver = await resolverRealocacao({
      produto_id: produtoWmsId,
      empresa_origem_id: empresaOrigemId,
      galpao_id: galpaoId,
      localizacoes_excluir,
      qty_residual: totalResidual,
    });

    if (resolver.status === "sem_cobertura") {
      // Marca todos os pedidos com items residuais como pendente_realocacao
      const pedidoIdsResiduais = [
        ...new Set(itemsResiduais.map((u) => u.pedido_id)),
      ];
      await supabase
        .from("siso_pedidos")
        .update({ status_separacao: "pendente_realocacao" })
        .in("id", pedidoIdsResiduais);

      for (const u of itemsResiduais) {
        await registrarEvento({
          pedidoId: u.pedido_id,
          evento: "realocacao_sem_cobertura_galpao",
          detalhes: {
            item_id: u.item.id,
            sku: u.item.sku,
            qty_residual: u.qty_residual,
          },
          usuarioId: session.id,
        });
      }

      return NextResponse.json({
        status: "aguardando_supervisor",
        motivo: "sem_cobertura_total",
      });
    }

    // Distribui as realocações encontradas entre items residuais (FCFS)
    type LinhaInsert = {
      pedido_item_id: number;
      empresa_dona_id: string;
      galpao_id: string;
      localizacao_id: string;
      quantidade: number;
      is_emprestimo: boolean;
      empresa_devedora_id: string | null;
      motivo: string;
      criado_por: string;
    };
    const linhasInsert: LinhaInsert[] = [];
    let idxItemResid = 0;
    let restanteItemAtual = itemsResiduais[0]?.qty_residual ?? 0;

    for (const r of resolver.realocacoes) {
      let qtyDessaReal = r.quantidade;
      while (qtyDessaReal > 0 && idxItemResid < itemsResiduais.length) {
        const u = itemsResiduais[idxItemResid];
        const slice = Math.min(qtyDessaReal, restanteItemAtual);
        if (slice > 0) {
          linhasInsert.push({
            pedido_item_id: Number(u.item.id),
            empresa_dona_id: r.empresa_dona_id,
            galpao_id: galpaoId,
            localizacao_id: r.localizacao_id,
            quantidade: slice,
            is_emprestimo: r.is_emprestimo,
            empresa_devedora_id: r.empresa_devedora_id,
            motivo: "loc_zerou",
            criado_por: session.id,
          });
          qtyDessaReal -= slice;
          restanteItemAtual -= slice;
        }
        if (restanteItemAtual === 0) {
          idxItemResid++;
          restanteItemAtual = itemsResiduais[idxItemResid]?.qty_residual ?? 0;
        }
      }
    }

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(linhasInsert)
      .select("id, pedido_item_id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial",
        message: "Falhou criar realocações",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { pedido_item_ids: itemIdsResiduais, rows: linhasInsert },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    const codigoPorLoc = new Map(
      resolver.realocacoes.map((r) => [r.localizacao_id, r.localizacao_codigo]),
    );

    return NextResponse.json({
      status: "realocado",
      realocacoes: (criadas ?? []).map((c) => ({
        id: c.id,
        pedido_item_id: c.pedido_item_id,
        empresa_dona_id: c.empresa_dona_id,
        localizacao_id: c.localizacao_id,
        localizacao_codigo: codigoPorLoc.get(c.localizacao_id as string) ?? null,
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
      metadata: { pedido_item_ids, quantidade_pega, loc_zerou },
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
    if (!pedido.empresa_origem_id) {
      return NextResponse.json({ error: "pedido sem empresa de origem" }, { status: 400 });
    }
    const empresaOrigemPedido = pedido.empresa_origem_id;

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

    // 10. Cascade — busca próxima loc no galpão, excluindo todas já tentadas neste item
    // (empresaOrigemPedido já validado no Step 2 — cascade prioriza empresa original)

    // Coleta todas as locs já tentadas neste item (qualquer status)
    const { data: todasRealoc } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("localizacao_id")
      .eq("pedido_item_id", item.id);

    // Loc original do item — resolver o uuid WMS a partir do código no estoque legacy
    const { data: estoqueLegacy } = await supabase
      .from("siso_pedido_item_estoques")
      .select("localizacao")
      .eq("pedido_id", item.pedido_id)
      .eq("produto_id", item.produto_id)
      .eq("empresa_id", empresaOrigemPedido)
      .maybeSingle();

    const locOriginalId = await resolverLocalizacaoWms(
      realoc.galpao_id,
      estoqueLegacy?.localizacao ?? null,
    );

    const localizacoes_excluir = Array.from(
      new Set([
        locOriginalId,
        ...(todasRealoc ?? []).map((r) => r.localizacao_id as string),
      ]),
    );

    // Resolver produto na empresa origem do pedido (pode diferir do produtoWmsId
    // quando a realocação atual era empréstimo de outra empresa do grupo)
    const produtoWmsOrigemId = await resolverProdutoWms(
      empresaOrigemPedido,
      String(item.produto_id),
    );

    const resolver = await resolverRealocacao({
      produto_id: produtoWmsOrigemId,
      empresa_origem_id: empresaOrigemPedido,
      galpao_id: realoc.galpao_id,
      localizacoes_excluir,
      qty_residual: qtyResidual,
    });

    if (resolver.status === "sem_cobertura") {
      await registrarEvento({
        pedidoId: pedido.id,
        evento: "realocacao_sem_cobertura_cascade",
        detalhes: {
          item_id: item.id,
          realocacao_id: realoc.id,
          sku: item.sku,
          qty_residual: qtyResidual,
        },
        usuarioId: session.id,
      });
      return NextResponse.json({ status: "sem_cobertura" });
    }

    const rows = resolver.realocacoes.map((r) => ({
      pedido_item_id: item.id,
      parent_realocacao_id: realoc.id,
      empresa_dona_id: r.empresa_dona_id,
      galpao_id: realoc.galpao_id,
      localizacao_id: r.localizacao_id,
      quantidade: r.quantidade,
      is_emprestimo: r.is_emprestimo,
      empresa_devedora_id: r.empresa_devedora_id,
      motivo: loc_zerou ? "cascade_loc_zerou" : "cascade_parcial",
      criado_por: session.id,
    }));

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(rows)
      .select("id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial-realoc",
        message: "Falhou criar realocações no cascade",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { realocacao_id: realoc.id, rows },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    await registrarEvento({
      pedidoId: pedido.id,
      evento: "realocacao_parcial_cascade",
      detalhes: {
        item_id: item.id,
        realocacao_id_origem: realoc.id,
        qtd_novas_realocacoes: criadas?.length ?? 0,
        sku: item.sku,
      },
      usuarioId: session.id,
    });

    const codigoPorLoc = new Map(
      resolver.realocacoes.map((r) => [r.localizacao_id, r.localizacao_codigo]),
    );

    return NextResponse.json({
      status: "realocado",
      realocacoes: (criadas ?? []).map((c) => ({
        id: c.id,
        empresa_dona_id: c.empresa_dona_id,
        localizacao_id: c.localizacao_id,
        localizacao_codigo: codigoPorLoc.get(c.localizacao_id as string) ?? null,
        quantidade: c.quantidade,
        is_emprestimo: c.is_emprestimo,
      })),
    });
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
