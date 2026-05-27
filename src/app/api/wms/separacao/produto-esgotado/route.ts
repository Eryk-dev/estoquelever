import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { getSessionUser } from "@/lib/session";
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";

/**
 * POST /api/separacao/produto-esgotado
 *
 * Three modes based on `acao`:
 *
 * 1. No `acao` (preview): checks which galpões have stock for this SKU
 *    and returns alternatives. No mutations.
 *    Body: { sku }
 *    Returns: { pedidos_afetados, itens_afetados, galpoes_alternativos: [{galpao_id, galpao_nome}] }
 *
 * 2. acao: "oc": current behavior — marks items for purchase, creates OC.
 *    Body: { sku, acao: "oc" }
 *    Returns: { pedidos_afetados, itens_afetados, ordem_compra_id }
 *
 * 3. acao: "encaminhar": redirects affected pedidos to another galpão.
 *    Body: { sku, acao: "encaminhar", galpao_destino_id: string }
 *    Returns: { pedidos_afetados, itens_afetados, galpao_destino_nome }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const sku = body?.sku;
  const acao: string | undefined = body?.acao;
  const galpaoDestinoId: string | undefined = body?.galpao_destino_id;

  if (!sku || typeof sku !== "string") {
    return NextResponse.json(
      { error: "Campo 'sku' obrigatorio" },
      { status: 400 },
    );
  }

  if (acao && acao !== "oc" && acao !== "encaminhar") {
    return NextResponse.json(
      { error: "acao deve ser 'oc' ou 'encaminhar'" },
      { status: 400 },
    );
  }

  if (acao === "encaminhar" && !galpaoDestinoId) {
    return NextResponse.json(
      { error: "galpao_destino_id obrigatorio para acao 'encaminhar'" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // 1. Find all pedidos in active separation
    const ACTIVE_STATUSES = [
      "aguardando_nf",
      "aguardando_separacao",
      "em_separacao",
      "pendente_realocacao",
    ];

    const { data: activePedidos, error: pedidosErr } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id, separacao_galpao_id")
      .in("status_separacao", ACTIVE_STATUSES);

    if (pedidosErr) {
      logger.error("produto-esgotado", "Erro ao buscar pedidos ativos", {
        error: pedidosErr.message,
      });
      return NextResponse.json(
        { error: "Erro ao buscar pedidos" },
        { status: 500 },
      );
    }

    const activePedidoIds = (activePedidos ?? []).map((p) => p.id);
    if (activePedidoIds.length === 0) {
      return NextResponse.json({
        pedidos_afetados: 0,
        itens_afetados: 0,
        galpoes_alternativos: [],
      });
    }

    // 2. Find items with this SKU in those pedidos (any compra_status)
    const { data: matchingItems, error: itemsErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, quantidade_pedida")
      .eq("sku", sku)
      .in("pedido_id", activePedidoIds);

    if (itemsErr) {
      logger.error("produto-esgotado", "Erro ao buscar itens", {
        error: itemsErr.message,
        sku,
      });
      return NextResponse.json(
        { error: "Erro ao buscar itens" },
        { status: 500 },
      );
    }

    if (!matchingItems || matchingItems.length === 0) {
      return NextResponse.json({
        pedidos_afetados: 0,
        itens_afetados: 0,
        galpoes_alternativos: [],
      });
    }

    const itemIds = matchingItems.map((i) => i.id);
    const affectedPedidoIds = [
      ...new Set(matchingItems.map((i) => i.pedido_id as string)),
    ];
    const produtoIds = [
      ...new Set(matchingItems.map((i) => i.produto_id as number)),
    ];

    // 3. Check stock in other galpões (for preview + encaminhar validation)
    const { data: estoqueOutros } = await supabase
      .from("siso_pedido_item_estoques")
      .select(
        "empresa_id, saldo, siso_empresas!inner(galpao_id, siso_galpoes!siso_empresas_galpao_id_fkey!inner(id, nome))",
      )
      .in("pedido_id", affectedPedidoIds)
      .in("produto_id", produtoIds);

    // Find current galpão(s) of affected pedidos
    const currentGalpaoIds = new Set<string>();
    for (const p of activePedidos ?? []) {
      if (affectedPedidoIds.includes(p.id) && p.separacao_galpao_id) {
        currentGalpaoIds.add(p.separacao_galpao_id);
      }
    }

    // Aggregate stock by galpão (excluding current galpões)
    const galpaoStock = new Map<
      string,
      { galpao_id: string; galpao_nome: string; saldo_total: number }
    >();
    for (const est of estoqueOutros ?? []) {
      const empresa = est.siso_empresas as unknown as {
        galpao_id: string;
        siso_galpoes: { id: string; nome: string };
      } | null;
      if (!empresa) continue;

      const gId = empresa.siso_galpoes.id;
      if (currentGalpaoIds.has(gId)) continue; // skip current galpão

      const existing = galpaoStock.get(gId);
      if (existing) {
        existing.saldo_total += (est.saldo as number) ?? 0;
      } else {
        galpaoStock.set(gId, {
          galpao_id: gId,
          galpao_nome: empresa.siso_galpoes.nome,
          saldo_total: (est.saldo as number) ?? 0,
        });
      }
    }

    const galpoesAlternativos = [...galpaoStock.values()]
      .filter((g) => g.saldo_total > 0)
      .map((g) => ({ galpao_id: g.galpao_id, galpao_nome: g.galpao_nome }));

    // ─── Preview mode (no acao) ─────────────────────────────────
    if (!acao) {
      return NextResponse.json({
        pedidos_afetados: affectedPedidoIds.length,
        itens_afetados: itemIds.length,
        galpoes_alternativos: galpoesAlternativos,
      });
    }

    // ─── Encaminhar mode ────────────────────────────────────────
    if (acao === "encaminhar") {
      // Validate destination galpão
      const { data: galpaoDestino } = await supabase
        .from("siso_galpoes")
        .select("id, nome")
        .eq("id", galpaoDestinoId!)
        .single();

      if (!galpaoDestino) {
        return NextResponse.json(
          { error: "Galpao destino nao encontrado" },
          { status: 404 },
        );
      }

      // Reset separation state em TODOS os itens dos pedidos afetados — pedido inteiro
      // está saindo do galpão atual, então toda mov S+L emitida durante o picking
      // precisa ser ESTORNADA antes do encaminhar (#2.8). Bypassar o helper deixava
      // saldo fantasma no galpão antigo.
      const { data: todosItens, error: todosItensErr } = await supabase
        .from("siso_pedido_itens")
        .select("id")
        .in("pedido_id", affectedPedidoIds);

      if (todosItensErr) {
        logger.error("produto-esgotado", "Erro ao listar itens dos pedidos pra reset", {
          error: todosItensErr.message,
          affectedPedidoIds,
        });
        return NextResponse.json(
          { error: "Erro ao listar itens pra reset" },
          { status: 500 },
        );
      }

      const todosItemIds = (todosItens ?? []).map((i) => Number(i.id));

      try {
        await resetarEstadoSeparacaoItens({
          supabase,
          itemIds: todosItemIds,
          usuarioId: session.id,
          motivo: "esgotado",
        });
      } catch (resetErr) {
        logger.error("produto-esgotado", "Reset com estorno falhou", {
          error: resetErr instanceof Error ? resetErr.message : String(resetErr),
          affectedPedidoIds,
        });
        return NextResponse.json(
          { error: "Erro ao estornar movs antes de encaminhar" },
          { status: 500 },
        );
      }

      // Move pedidos to aguardando_separacao with new galpão
      const { error: updatePedidosErr } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "aguardando_separacao",
          separacao_galpao_id: galpaoDestinoId,
          separacao_operador_id: null,
          separacao_iniciada_em: null,
          separacao_concluida_em: null,
        })
        .in("id", affectedPedidoIds);

      if (updatePedidosErr) {
        logger.error("produto-esgotado", "Erro ao encaminhar pedidos", {
          error: updatePedidosErr.message,
        });
        return NextResponse.json(
          { error: "Erro ao encaminhar pedidos" },
          { status: 500 },
        );
      }

      logger.info("produto-esgotado", "SKU esgotado — pedidos encaminhados", {
        sku,
        galpao_destino: galpaoDestino.nome,
        pedidos_afetados: affectedPedidoIds.length,
        itens_afetados: itemIds.length,
      });

      return NextResponse.json({
        pedidos_afetados: affectedPedidoIds.length,
        itens_afetados: itemIds.length,
        galpao_destino_nome: galpaoDestino.nome,
      });
    }

    // ─── OC mode (acao: "oc") ───────────────────────────────────
    const fornecedorInfo = getFornecedorBySku(sku);
    const now = new Date().toISOString();

    // Re-fetch matching items with quantidade_pega pra calcular residual.
    // Sem isso, o OC seria criado pela qty pedida total — mas se uma realocação
    // já pegou parte do item (quantidade_pega>0 no item ou nas realocs picadas),
    // o residual real é menor. Pedir a qty total causaria compra duplicada.
    const { data: itemsComPega } = await supabase
      .from("siso_pedido_itens")
      .select("id, quantidade_pedida, quantidade_pega")
      .in("id", itemIds);
    const itemsPegaMap = new Map<number, { qPedida: number; qPega: number }>();
    for (const it of itemsComPega ?? []) {
      itemsPegaMap.set(it.id as number, {
        qPedida: Number(it.quantidade_pedida ?? 0),
        qPega: Number(it.quantidade_pega ?? 0),
      });
    }

    // Itens que efetivamente serão marcados pra compra (residual > 0)
    const itemsParaOC: Array<{ id: number; residual: number }> = [];

    // Update matching items: mark for purchase with the real missing quantity.
    for (const item of matchingItems) {
      // Soma qty_pega das realocações já picadas pra este item (modo realoc preserva
      // quantidade_pega no item, mas em alguns paths a qty fica só nas realocs).
      const { data: realocsPicadas } = await supabase
        .from("siso_pedido_item_realocacoes")
        .select("quantidade_pega")
        .eq("pedido_item_id", item.id)
        .in("status", ["picado", "picado_parcial"]);

      const qtyPegaRealocs = (realocsPicadas ?? []).reduce(
        (s, r) => s + (Number(r.quantidade_pega) || 0),
        0,
      );
      const itemInfo = itemsPegaMap.get(item.id as number);
      const qtyPegaItem = itemInfo?.qPega ?? 0;
      const qtyPedida = itemInfo?.qPedida ?? Number(item.quantidade_pedida ?? 0);
      const qtyPegaTotal = qtyPegaItem + qtyPegaRealocs;
      const residual = Math.max(0, qtyPedida - qtyPegaTotal);

      if (residual === 0) {
        // Nada a comprar — pula este item (já 100% coberto por realocs)
        logger.info("produto-esgotado", "item já coberto por realocação, sem residual a comprar", {
          sku,
          itemId: item.id,
          qtyPedida,
          qtyPegaItem,
          qtyPegaRealocs,
        });
        continue;
      }

      const { error: updateItemsErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          compra_status: "aguardando_compra",
          fornecedor_oc: fornecedorInfo.fornecedor,
          compra_quantidade_solicitada: residual,
          compra_solicitada_em: now,
        })
        .eq("id", item.id);

      if (updateItemsErr) {
        logger.error("produto-esgotado", "Erro ao atualizar itens", {
          error: updateItemsErr.message,
          itemId: item.id,
        });
        return NextResponse.json(
          { error: "Erro ao atualizar itens" },
          { status: 500 },
        );
      }

      itemsParaOC.push({ id: item.id as number, residual });
    }

    // Se nenhum item tem residual a comprar (tudo já coberto por realocação),
    // não cria OC nem move pedidos pra aguardando_compra — apenas retorna.
    if (itemsParaOC.length === 0) {
      logger.info("produto-esgotado", "SKU esgotado mas tudo coberto por realocação — sem OC", {
        sku,
        itens_afetados: itemIds.length,
      });
      return NextResponse.json({
        pedidos_afetados: affectedPedidoIds.length,
        itens_afetados: 0,
        ordem_compra_id: null,
      });
    }

    // OC branch: só reseta itens do SKU esgotado, não pedido inteiro (#2.14).
    // Itens de outros SKUs do mesmo pedido continuam picados normalmente — só
    // o SKU sem cobertura vai virar OC, então preservar pick state dos outros.
    // Também ESTORNAR S+L emitidas no pick antes do switch pra aguardando_compra
    // (#2.8 — mesmo bug do branch encaminhar).
    try {
      await resetarEstadoSeparacaoItens({
        supabase,
        itemIds: itemIds.map((id) => Number(id)),
        usuarioId: session.id,
        motivo: "esgotado",
      });
    } catch (resetErr) {
      logger.error("produto-esgotado", "Reset com estorno falhou (OC branch)", {
        error: resetErr instanceof Error ? resetErr.message : String(resetErr),
      });
      return NextResponse.json(
        { error: "Erro ao estornar movs antes de marcar OC" },
        { status: 500 },
      );
    }

    // Move affected pedidos to aguardando_compra
    const { error: updatePedidosErr } = await supabase
      .from("siso_pedidos")
      .update({
        status_separacao: "aguardando_compra",
        separacao_operador_id: null,
        separacao_iniciada_em: null,
        separacao_concluida_em: null,
      })
      .in("id", affectedPedidoIds);

    if (updatePedidosErr) {
      logger.error("produto-esgotado", "Erro ao mover pedidos", {
        error: updatePedidosErr.message,
      });
      return NextResponse.json(
        { error: "Erro ao mover pedidos" },
        { status: 500 },
      );
    }

    // Auto-create OC and link items to it
    let ordemCompraId: string | null = null;
    const fornecedor = fornecedorInfo.fornecedor;

    try {
      const { data: pedidoData } = await supabase
        .from("siso_pedidos")
        .select("empresa_origem_id")
        .in("id", affectedPedidoIds)
        .not("empresa_origem_id", "is", null)
        .limit(1)
        .single();

      const empresaId = pedidoData?.empresa_origem_id;

      if (empresaId) {
        // Resolve galpao_id from the empresa
        const { data: empresaData } = await supabase
          .from("siso_empresas")
          .select("galpao_id")
          .eq("id", empresaId)
          .single();
        const galpaoId = empresaData?.galpao_id ?? null;

        // Look for existing draft OC by fornecedor + galpao (not empresa_id)
        let existingOCQuery = supabase
          .from("siso_ordens_compra")
          .select("id")
          .eq("fornecedor", fornecedor)
          .eq("status", "aguardando_compra")
          .limit(1);

        if (galpaoId) {
          existingOCQuery = existingOCQuery.eq("galpao_id", galpaoId);
        } else {
          existingOCQuery = existingOCQuery.eq("empresa_id", empresaId);
        }

        const { data: existingOC } = await existingOCQuery.maybeSingle();

        if (existingOC) {
          ordemCompraId = existingOC.id;
        } else {
          const { data: newOC, error: ocError } = await supabase
            .from("siso_ordens_compra")
            .insert({
              fornecedor,
              galpao_id: galpaoId,
              empresa_id: empresaId,
              status: "aguardando_compra",
              observacao: `Criada automaticamente — SKU ${sku} esgotado`,
            })
            .select("id")
            .single();

          if (ocError) {
            logger.warn("produto-esgotado", "Erro ao criar OC automatica", {
              error: ocError.message,
              fornecedor,
              empresaId,
            });
          } else {
            ordemCompraId = newOC.id;
          }
        }

        if (ordemCompraId) {
          // Vincula apenas itens com residual a comprar (não os 100% cobertos por realoc).
          const itemsParaOCIds = itemsParaOC.map((i) => i.id);
          const { error: linkError } = await supabase
            .from("siso_pedido_itens")
            .update({ ordem_compra_id: ordemCompraId })
            .in("id", itemsParaOCIds);

          if (linkError) {
            logger.warn("produto-esgotado", "Erro ao vincular itens a OC", {
              error: linkError.message,
              ordemCompraId,
            });
          }
        }
      }
    } catch (ocErr) {
      logger.warn(
        "produto-esgotado",
        "Erro ao criar OC automatica (nao-critico)",
        {
          error: ocErr instanceof Error ? ocErr.message : String(ocErr),
          sku,
        },
      );
    }

    logger.info("produto-esgotado", "SKU marcado como esgotado → OC", {
      sku,
      fornecedor,
      pedidos_afetados: affectedPedidoIds.length,
      itens_afetados: itemsParaOC.length,
      ordem_compra_id: ordemCompraId,
    });

    return NextResponse.json({
      pedidos_afetados: affectedPedidoIds.length,
      itens_afetados: itemsParaOC.length,
      ordem_compra_id: ordemCompraId,
    });
  } catch (err) {
    logger.error("produto-esgotado", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      sku,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
