import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { getSessionUser } from "@/lib/session";
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";
import { galpoesComSaldo } from "@/lib/wms/galpoes-com-saldo";
import { resolverProdutoWmsFlex } from "@/lib/separacao/wms-mapping";
import { registrarEventos } from "@/lib/historico-service";

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

  // P2-SEP-01: galpão obrigatório. Sem o filtro, a busca de pedidos ativos
  // pegava pedidos de TODOS os galpões e o esgotado/OC/encaminhar derrubava
  // separações de galpões que não tinham nada a ver com este operador.
  // X-Galpao-Id popula session.galpaoId; body.galpao_id é override explícito.
  const galpao: string | null = body?.galpao_id ?? session.galpaoId ?? null;

  if (!sku || typeof sku !== "string") {
    return NextResponse.json(
      { error: "Campo 'sku' obrigatorio" },
      { status: 400 },
    );
  }

  if (!galpao) {
    return NextResponse.json(
      { error: "galpao_obrigatorio" },
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
      .in("status_separacao", ACTIVE_STATUSES)
      // P2-SEP-01: restringe ao galpão do operador — nunca toca pedidos de outro.
      .eq("separacao_galpao_id", galpao)
      // Full tem lane própria — não entra no recompute de "produto esgotado" da normal.
      .eq("separacao_full", false);

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

    // 3. Check stock in other galpões via LIVE siso_estoque (Fase 1.4 — era
    //    snapshot siso_pedido_item_estoques). Resolve o produto WMS pela empresa
    //    origem de um pedido afetado e lista galpões com disponível > 0,
    //    excluindo o(s) galpão(ões) atual(is) da separação.
    const currentGalpaoIds = new Set<string>();
    for (const p of activePedidos ?? []) {
      if (affectedPedidoIds.includes(p.id) && p.separacao_galpao_id) {
        currentGalpaoIds.add(p.separacao_galpao_id);
      }
    }

    const primeiroAfetado = (activePedidos ?? []).find(
      (p) => affectedPedidoIds.includes(p.id) && p.empresa_origem_id,
    );
    let galpoesAlternativos: Array<{ galpao_id: string; galpao_nome: string }> = [];
    if (primeiroAfetado?.empresa_origem_id && produtoIds.length > 0) {
      try {
        const produtoWmsId = await resolverProdutoWmsFlex(
          primeiroAfetado.empresa_origem_id as string,
          { tinyProdutoId: produtoIds[0], sku },
        );
        const alt = await galpoesComSaldo(produtoWmsId);
        galpoesAlternativos = alt
          .filter((g) => !currentGalpaoIds.has(g.galpao_id))
          .map((g) => ({ galpao_id: g.galpao_id, galpao_nome: g.galpao_nome }));
      } catch (e) {
        logger.warn("produto-esgotado", "falha resolvendo galpões alternativos (vivo)", {
          sku,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

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

    // P2-SEP-02: o RESET (estorno dos picks) roda ANTES do cálculo do residual.
    // Antes, o residual era calculado com quantidade_pega/realocs picadas AINDA
    // vivas — depois o reset zerava tudo e estornava as S, então a OC pedia
    // MENOS do que a necessidade física real (drift físico×ledger: peça volta
    // pra prateleira mas a OC compra só a fração). Pós-reset, quantidade_pega=0
    // e as S estão estornadas → residual = necessidade cheia (= quantidade_pedida).

    // Snapshot pré-reset só pra auditoria do evento (qty que será devolvida à
    // prateleira ao estornar os picks). Não entra no cálculo do residual.
    const { data: itemsPreReset } = await supabase
      .from("siso_pedido_itens")
      .select("id, quantidade_pedida, quantidade_pega")
      .in("id", itemIds);
    const preResetMap = new Map<number, { qPedida: number; qPega: number }>();
    for (const it of itemsPreReset ?? []) {
      preResetMap.set(it.id as number, {
        qPedida: Number(it.quantidade_pedida ?? 0),
        qPega: Number(it.quantidade_pega ?? 0),
      });
    }
    let qtyEstornadaPick = 0;
    for (const v of preResetMap.values()) qtyEstornadaPick += v.qPega;

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
        affectedPedidoIds,
        itemIds,
      });
      return NextResponse.json(
        { error: "Erro ao estornar movs antes de marcar OC" },
        { status: 500 },
      );
    }

    // Re-fetch pós-reset: quantidade_pega foi zerada e as S estornadas, então o
    // residual a comprar é a necessidade cheia. Pedir a qty pedida completa
    // agora é CORRETO — a peça parcial voltou pra prateleira.
    const { data: itemsPosReset } = await supabase
      .from("siso_pedido_itens")
      .select("id, quantidade_pedida")
      .in("id", itemIds);
    const qtyPedidaMap = new Map<number, number>();
    for (const it of itemsPosReset ?? []) {
      qtyPedidaMap.set(it.id as number, Number(it.quantidade_pedida ?? 0));
    }

    // Itens que efetivamente serão marcados pra compra (residual > 0)
    const itemsParaOC: Array<{ id: number; residual: number }> = [];

    // Update matching items: mark for purchase with the full (post-reset) need.
    for (const item of matchingItems) {
      const residual =
        qtyPedidaMap.get(item.id as number) ??
        Number(item.quantidade_pedida ?? 0);

      if (residual === 0) {
        // Pedido sem quantidade pedida — nada a comprar (defensivo).
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

    // Se nenhum item tem residual a comprar — apenas retorna.
    if (itemsParaOC.length === 0) {
      logger.info("produto-esgotado", "SKU esgotado mas sem residual a comprar — sem OC", {
        sku,
        itens_afetados: itemIds.length,
      });
      return NextResponse.json({
        pedidos_afetados: affectedPedidoIds.length,
        itens_afetados: 0,
        ordem_compra_id: null,
      });
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
      qty_estornada_pick: qtyEstornadaPick,
    });

    // P2-SEP-02: quando havia picks estornados, registra evento instrutivo por
    // pedido — o operador precisa DEVOLVER as peças já pegas à prateleira (o S
    // foi estornado, o saldo voltou ao ledger, mas a peça pode estar na bancada).
    if (qtyEstornadaPick > 0) {
      registrarEventos(
        affectedPedidoIds.map((pid) => ({
          pedidoId: pid,
          evento: "status_revertido" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: {
            motivo: "esgotado_para_oc",
            sku,
            qty_estornada_pick: qtyEstornadaPick,
            instrucao: "devolver peças à prateleira",
          },
        })),
      ).catch(() => {});
    }

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
