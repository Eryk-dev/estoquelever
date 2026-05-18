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

  // Modo realocação aceita realocacao_id (single, compat) OU realocacao_ids (array,
  // pra UI consolidada quando o cascade encontra cobertura na MESMA loc pra múltiplos
  // pedido_items residuais).
  const isRealocacaoMode =
    body &&
    (typeof body.realocacao_id === "string" ||
      (Array.isArray(body.realocacao_ids) && body.realocacao_ids.length > 0));
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
          "campo 'pedido_item_id'/'pedido_item_ids' OU 'realocacao_id'/'realocacao_ids' obrigatório",
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
  const realocIds: string[] = Array.isArray(body.realocacao_ids)
    ? body.realocacao_ids
    : [body.realocacao_id];
  return processarParcialRealocacao(
    supabase,
    session,
    realocIds,
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

    // 9a. Popula tabela ponte siso_pedido_item_mov_links — 1 linha por item com qty>0
    //     pra mov de saída (rateada), e 1 linha pro primeiro beneficiado se houve
    //     mov de ajuste loc_zerou (ajuste é da loc, não rateado).
    if (movSaidaId) {
      const linksData: Array<{
        pedido_item_id: number;
        realocacao_id: null;
        mov_id: string;
        qty: number;
        tipo_link: "saida" | "ajuste_loc_zerou";
      }> = [];

      for (const upd of itemUpdates) {
        if (upd.qty_para_este > 0) {
          linksData.push({
            pedido_item_id: Number(upd.item.id),
            realocacao_id: null,
            mov_id: movSaidaId,
            qty: upd.qty_para_este,
            tipo_link: "saida",
          });
        }
      }

      if (linksData.length > 0) {
        const { error: linkErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert(linksData);
        if (linkErr) {
          logger.logError({
            error: linkErr,
            source: "separacao-parcial-item",
            message: "Falhou criar links",
            category: "database",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { movSaidaId, linksData },
          });
          return NextResponse.json({ error: "erro persistindo links" }, { status: 500 });
        }
      }
    }

    if (movAjusteId && loc_zerou) {
      const delta = saldoWms - quantidade_pega;
      if (delta > 0) {
        // ajuste é da loc, não rateado entre itens — vai no primeiro beneficiado
        const { error: linkAjErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert({
            pedido_item_id: Number(itemsRaw[indexPrimeiroBeneficiado].id),
            realocacao_id: null,
            mov_id: movAjusteId,
            qty: delta,
            tipo_link: "ajuste_loc_zerou",
          });
        if (linkAjErr) {
          logger.logError({
            error: linkAjErr,
            source: "separacao-parcial-item",
            message: "Falhou criar link de ajuste",
            category: "database",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { movAjusteId, delta },
          });
          return NextResponse.json({ error: "erro persistindo links" }, { status: 500 });
        }
      }
    }

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
          // Legacy field: mov_saida vinculada a TODOS os beneficiários (qty > 0)
          // pra desfazer-parcial/cancelar legados localizarem a mov. A tabela ponte
          // (criada acima) é a fonte de verdade pra rateamento.
          mov_saida_id: qty_para_este > 0 ? movSaidaId : null,
          // mov_ajuste é da loc — fica só no primeiro beneficiário (não rateado)
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
  realocacao_ids: string[],
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
  try {
    // 1. Carrega TODAS as realocações (ordem por criado_em pra distribuição determinística)
    const { data: realocs, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select(`
        id, pedido_item_id, empresa_dona_id, galpao_id, localizacao_id,
        quantidade, is_emprestimo, empresa_devedora_id, status, criado_em
      `)
      .in("id", realocacao_ids)
      .order("criado_em", { ascending: true });

    if (realocErr || !realocs || realocs.length === 0) {
      return NextResponse.json({ error: "realocação(ões) não encontrada(s)" }, { status: 404 });
    }
    if (realocs.length !== realocacao_ids.length) {
      return NextResponse.json(
        { error: "algumas realocações não foram encontradas" },
        { status: 404 },
      );
    }

    // 2. Valida: todas aguardando_picking
    const naoAguardando = realocs.find((r) => r.status !== "aguardando_picking");
    if (naoAguardando) {
      return NextResponse.json(
        {
          error: `realocação ${naoAguardando.id} não está aguardando picking (atual: ${naoAguardando.status})`,
        },
        { status: 409 },
      );
    }

    // 3. Valida invariantes: mesma loc + mesma empresa_dona + mesmo galpao
    //    (UI só consolida realocs com essa chave; bate o invariante aqui)
    const locSet = new Set(realocs.map((r) => r.localizacao_id));
    const empresaDonaSet = new Set(realocs.map((r) => r.empresa_dona_id));
    const galpaoSet = new Set(realocs.map((r) => r.galpao_id));
    if (locSet.size > 1 || empresaDonaSet.size > 1 || galpaoSet.size > 1) {
      return NextResponse.json(
        { error: "realocações devem estar na mesma loc/empresa/galpão" },
        { status: 400 },
      );
    }

    const totalSugerido = realocs.reduce((s, r) => s + Number(r.quantidade), 0);
    if (quantidade_pega > totalSugerido) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder o total sugerido (${totalSugerido})` },
        { status: 400 },
      );
    }

    // 4. Carrega items pais + pedidos
    const itemIds = [...new Set(realocs.map((r) => r.pedido_item_id))];
    const { data: items, error: itemsErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega")
      .in("id", itemIds);

    if (itemsErr || !items || items.length !== itemIds.length) {
      return NextResponse.json({ error: "item(s) pai não encontrado(s)" }, { status: 404 });
    }
    const itemById = new Map(items.map((i) => [i.id, i]));

    const pedidoIds = [...new Set(items.map((i) => i.pedido_id))];
    const { data: pedidos, error: pedidosErr } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id")
      .in("id", pedidoIds);

    if (pedidosErr || !pedidos || pedidos.length !== pedidoIds.length) {
      return NextResponse.json({ error: "pedido(s) não encontrado(s)" }, { status: 404 });
    }
    const semEmpresa = pedidos.find((p) => !p.empresa_origem_id);
    if (semEmpresa) {
      return NextResponse.json(
        { error: `pedido ${semEmpresa.numero} sem empresa de origem` },
        { status: 400 },
      );
    }
    const pedidoById = new Map(pedidos.map((p) => [p.id, p]));

    // 5. Quadrupla comum (validada acima)
    const primeira = realocs[0];
    const empresaDonaId = primeira.empresa_dona_id;
    const galpaoId = primeira.galpao_id;
    const localizacaoId = primeira.localizacao_id;
    const isEmprestimo = primeira.is_emprestimo;
    const empresaDevedoraId = primeira.empresa_devedora_id;

    const primeiroItem = itemById.get(primeira.pedido_item_id)!;
    const primeiroPedido = pedidoById.get(primeiroItem.pedido_id)!;
    const empresaOrigemPrimeiroPedido = primeiroPedido.empresa_origem_id as string;

    const produtoTinyId = String(primeiroItem.produto_id);
    const produtoWmsId = await resolverProdutoWms(empresaDonaId, produtoTinyId);

    // 6. Saldo / reservado
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", empresaDonaId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", localizacaoId)
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

    // 7. Gera mov S única (qty_pega total) e mov ajuste (se loc_zerou) — vinculadas ao primeiro pedido
    const realocIdsList = realocs.map((r) => r.id);
    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      const mov = await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoWmsId,
          empresa_dona_id: empresaDonaId,
          galpao_id: galpaoId,
          localizacao_id: localizacaoId,
        },
        tipo: "S",
        qty: quantidade_pega,
        origem_tipo: isEmprestimo ? "emprestimo" : "nf_venda",
        origem_id: `pedido:${primeiroPedido.id}`,
        origem_detalhes: {
          pedido_numero: primeiroPedido.numero,
          pedido_item_ids: itemIds,
          realocacao_ids: realocIdsList,
          sku: primeiroItem.sku,
          contexto:
            realocs.length > 1 ? "realocacao_parcial_consolidado" : "realocacao_parcial",
        },
        emprestimo_devedora_id: isEmprestimo ? empresaDevedoraId ?? undefined : undefined,
        observacoes:
          realocs.length > 1
            ? `Picking parcial wave realocada — ${realocs.length} realocações (pedido #${primeiroPedido.numero}…)`
            : isEmprestimo
              ? `Picking parcial pedido #${primeiroPedido.numero} — empréstimo`
              : `Picking parcial pedido #${primeiroPedido.numero} — realocação`,
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
            empresa_dona_id: empresaDonaId,
            galpao_id: galpaoId,
            localizacao_id: localizacaoId,
          },
          tipo: "S",
          qty: delta,
          origem_tipo: "ajuste_pick_zerou",
          origem_id: `pedido:${primeiroPedido.id}`,
          origem_detalhes: {
            pedido_numero: primeiroPedido.numero,
            pedido_item_ids: itemIds,
            realocacao_ids: realocIdsList,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou na realocação — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    // 8. Distribui qty_pega entre realocs em ordem (FCFS)
    type RealocUpdate = {
      realoc: typeof realocs[number];
      qty_para_esta: number;
      qty_residual: number;
    };
    let qtyRestante = quantidade_pega;
    const updates: RealocUpdate[] = [];
    for (const r of realocs) {
      const qtdSugerida = Number(r.quantidade);
      const qtyParaEsta = Math.min(qtdSugerida, qtyRestante);
      qtyRestante -= qtyParaEsta;
      updates.push({
        realoc: r,
        qty_para_esta: qtyParaEsta,
        qty_residual: qtdSugerida - qtyParaEsta,
      });
    }

    const indexPrimeiroBeneficiario =
      updates.findIndex((u) => u.qty_para_esta > 0) >= 0
        ? updates.findIndex((u) => u.qty_para_esta > 0)
        : 0;

    const nowIso = new Date().toISOString();

    // 9. Update cada realocação + acumula no item pai
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      const { realoc, qty_para_esta, qty_residual } = u;
      const ehBeneficiario = i === indexPrimeiroBeneficiario;
      const isCompletoEsta = qty_residual === 0;
      const deveMarcar = qty_para_esta > 0 || loc_zerou;

      if (!deveMarcar) continue; // realoc fica como aguardando_picking pra próxima ação

      const isParcialEsta = !isCompletoEsta;

      const { error: updErr } = await supabase
        .from("siso_pedido_item_realocacoes")
        .update({
          status: isCompletoEsta ? "picado" : "picado_parcial",
          quantidade_pega: qty_para_esta,
          parcial: isParcialEsta,
          parcial_motivo: isParcialEsta
            ? loc_zerou ? "cascade_loc_zerou" : "cascade_parcial"
            : null,
          parcial_em: isParcialEsta ? nowIso : null,
          parcial_por: isParcialEsta ? session.id : null,
          picado_em: isCompletoEsta ? nowIso : null,
          picado_por: isCompletoEsta ? session.id : null,
          mov_saida_id: ehBeneficiario ? movSaidaId : null,
          mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,
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

      // Acumula qty no item pai
      const item = itemById.get(realoc.pedido_item_id)!;
      if (qty_para_esta > 0) {
        const novaQty = (Number(item.quantidade_pega) || 0) + qty_para_esta;
        await supabase
          .from("siso_pedido_itens")
          .update({ quantidade_pega: novaQty })
          .eq("id", item.id);
        // Atualiza cache local pra próximos updates somarem corretamente
        item.quantidade_pega = novaQty as unknown as typeof item.quantidade_pega;
      }

      const pedido = pedidoById.get(item.pedido_id)!;
      await registrarEvento({
        pedidoId: pedido.id,
        evento: isCompletoEsta ? "realocacao_picada" : "realocacao_parcial",
        detalhes: {
          item_id: item.id,
          realocacao_id: realoc.id,
          sku: item.sku,
          quantidade_pega: qty_para_esta,
          quantidade_sugerida: Number(realoc.quantidade),
          is_emprestimo: isEmprestimo,
          loc_zerou,
          wave_consolidado: realocs.length > 1,
        },
        usuarioId: session.id,
      });
    }

    // 10. Cascade — pra cada realoc com residual em loc_zerou=true, busca próxima loc
    const realocsResiduais = updates.filter((u) => u.qty_residual > 0);

    if (realocsResiduais.length === 0) {
      return NextResponse.json({ status: "completo" });
    }

    if (!loc_zerou) {
      // Sem loc_zerou, residuais ficam como aguardando_picking (não foram marcados)
      // — operador continua picando normalmente
      return NextResponse.json({ status: "completo" });
    }

    // loc_zerou=true: cascade pra cada item residual (cada um pode estar em pedido diferente)
    // Agrupa por item.id pra evitar dispatchar cascade duplicado pro mesmo item.
    const totalResidual = realocsResiduais.reduce((s, u) => s + u.qty_residual, 0);

    // Coleta TODAS as locs já tentadas em qualquer item envolvido
    const itemIdsRes = [
      ...new Set(realocsResiduais.map((u) => Number(u.realoc.pedido_item_id))),
    ];
    const { data: todasRealoc } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("localizacao_id, pedido_item_id")
      .in("pedido_item_id", itemIdsRes);

    // Loc original — usa do PRIMEIRO item residual
    const primeiroResid = realocsResiduais[0];
    const itemPrimResid = itemById.get(primeiroResid.realoc.pedido_item_id)!;
    const pedidoPrimResid = pedidoById.get(itemPrimResid.pedido_id)!;
    const empresaOrigemPrimResid = pedidoPrimResid.empresa_origem_id as string;

    const { data: estoqueLegacy } = await supabase
      .from("siso_pedido_item_estoques")
      .select("localizacao")
      .eq("pedido_id", itemPrimResid.pedido_id)
      .eq("produto_id", itemPrimResid.produto_id)
      .eq("empresa_id", empresaOrigemPrimResid)
      .maybeSingle();

    const locOriginalId = await resolverLocalizacaoWms(
      galpaoId,
      estoqueLegacy?.localizacao ?? null,
    );

    const localizacoes_excluir = Array.from(
      new Set([
        locOriginalId,
        localizacaoId, // a loc atual do cascade (a-02-3) também sai do pool
        ...((todasRealoc ?? []).map((r) => r.localizacao_id as string)),
      ]),
    );

    // Resolve produto na empresa origem do primeiro pedido residual
    const produtoWmsOrigemId = await resolverProdutoWms(
      empresaOrigemPrimResid,
      String(itemPrimResid.produto_id),
    );

    const resolver = await resolverRealocacao({
      produto_id: produtoWmsOrigemId,
      empresa_origem_id: empresaOrigemPrimResid,
      galpao_id: galpaoId,
      localizacoes_excluir,
      qty_residual: totalResidual,
    });

    if (resolver.status === "sem_cobertura") {
      for (const u of realocsResiduais) {
        const item = itemById.get(u.realoc.pedido_item_id)!;
        const pedido = pedidoById.get(item.pedido_id)!;
        await registrarEvento({
          pedidoId: pedido.id,
          evento: "realocacao_sem_cobertura_cascade",
          detalhes: {
            item_id: item.id,
            realocacao_id: u.realoc.id,
            sku: item.sku,
            qty_residual: u.qty_residual,
          },
          usuarioId: session.id,
        });
      }
      return NextResponse.json({ status: "sem_cobertura" });
    }

    // Distribui realocações encontradas entre realocsResiduais (FCFS pela ordem de items)
    type LinhaInsert = {
      pedido_item_id: number;
      parent_realocacao_id: string;
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
    let idxRes = 0;
    let restanteAtual = realocsResiduais[0]?.qty_residual ?? 0;

    for (const r of resolver.realocacoes) {
      let qtyDessaReal = r.quantidade;
      while (qtyDessaReal > 0 && idxRes < realocsResiduais.length) {
        const u = realocsResiduais[idxRes];
        const slice = Math.min(qtyDessaReal, restanteAtual);
        if (slice > 0) {
          linhasInsert.push({
            pedido_item_id: Number(u.realoc.pedido_item_id),
            parent_realocacao_id: u.realoc.id,
            empresa_dona_id: r.empresa_dona_id,
            galpao_id: galpaoId,
            localizacao_id: r.localizacao_id,
            quantidade: slice,
            is_emprestimo: r.is_emprestimo,
            empresa_devedora_id: r.empresa_devedora_id,
            motivo: loc_zerou ? "cascade_loc_zerou" : "cascade_parcial",
            criado_por: session.id,
          });
          qtyDessaReal -= slice;
          restanteAtual -= slice;
        }
        if (restanteAtual === 0) {
          idxRes++;
          restanteAtual = realocsResiduais[idxRes]?.qty_residual ?? 0;
        }
      }
    }

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(linhasInsert)
      .select("id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial-realoc",
        message: "Falhou criar realocações no cascade",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { realocacao_ids: realocIdsList, rows: linhasInsert },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    for (const u of realocsResiduais) {
      const item = itemById.get(u.realoc.pedido_item_id)!;
      const pedido = pedidoById.get(item.pedido_id)!;
      await registrarEvento({
        pedidoId: pedido.id,
        evento: "realocacao_parcial_cascade",
        detalhes: {
          item_id: item.id,
          realocacao_id_origem: u.realoc.id,
          qtd_novas_realocacoes: criadas?.filter(
            // Filter by parent in metadata not available — usa count total / N como aproximação
            () => true,
          )?.length ?? 0,
          sku: item.sku,
        },
        usuarioId: session.id,
      });
    }

    const codigoPorLoc = new Map(
      resolver.realocacoes.map((r) => [r.localizacao_id, r.localizacao_codigo]),
    );

    void empresaOrigemPrimeiroPedido; // mantido pra debug histórico (escopo unificado)

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
      metadata: { realocacao_ids, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
