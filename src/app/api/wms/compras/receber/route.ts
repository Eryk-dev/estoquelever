import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { checkAndReleasePedidos } from "@/lib/compras-release";
import { userCan } from "@/lib/permissions";
import { registrarEventos } from "@/lib/historico-service";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { resolverCustoEntrada } from "@/lib/wms/custo-fallback";

/**
 * POST /api/compras/receber
 *
 * Confirms receiving of purchased items. Supports partial receiving.
 * Allocates received qty to orders by aging (oldest first).
 * Identifies and releases orders where all purchase items are now received.
 *
 * Body: {
 *   itens: Array<{
 *     sku: string,
 *     quantidade_recebida: number,
 *     observacao?: string,
 *     custo_unitario?: number,     // opcional — alimenta recálculo do custo médio
 *     nota_fiscal_id?: string|null // opcional — uuid em siso_notas_fiscais
 *   }>
 * }
 *
 * Em WMS_AS_SOURCE (cutover Plano 6, default desde 2026-05-25), cada item
 * recebido emite uma mov E (origem_tipo='nf_compra') no ledger via
 * wms_inserir_movimentacao na loc RECEBIMENTO do galpão do pedido. Tags:
 * empresa_compradora_id, fornecedor_id (best-effort por nome), custo_unitario.
 *
 * Failure mode: per-item mov failure NÃO quebra o loop — apenas seta
 * compra_estoque_lancado_alerta=true no pedido pra operador investigar via UI.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const itens = body.itens as
    | Array<{
        sku: string;
        quantidade_recebida: number;
        observacao?: string;
        custo_unitario?: number;
        nota_fiscal_id?: string | null;
      }>
    | undefined;

  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    return NextResponse.json(
      { error: "Envie { itens: [{ sku, quantidade_recebida }] }" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const allAffectedItemIds: string[] = [];
  const recebimentoLog: Array<{
    sku: string;
    itens_atualizados: number;
    quantidade_alocada: number;
    movs_geradas: number;
    movs_falhas: number;
  }> = [];

  // Per-pedido audit aggregator (1 evento compra_item_recebido por pedido).
  const eventosPorPedido = new Map<
    string,
    { qty: number; skus: string[] }
  >();

  try {
    for (const { sku, quantidade_recebida, observacao, custo_unitario, nota_fiscal_id } of itens) {
      if (!sku || quantidade_recebida <= 0) continue;

      // Fetch all order items for this SKU that are "comprado" (awaiting delivery)
      const { data: orderItems, error: fetchErr } = await supabase
        .from("siso_pedido_itens")
        .select(
          "id, pedido_id, compra_quantidade_solicitada, compra_quantidade_recebida, compra_quantidade_comprada, quantidade_pedida, fornecedor_oc, siso_pedidos(criado_em, empresa_origem_id, separacao_galpao_id, nota_fiscal_id)",
        )
        .eq("sku", sku)
        .eq("compra_status", "comprado");

      if (fetchErr || !orderItems || orderItems.length === 0) continue;

      // Sort by order creation date (oldest first)
      const sorted = [...orderItems].sort((a, b) => {
        const dateA =
          (a.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        const dateB =
          (b.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        return dateA.localeCompare(dateB);
      });

      // Distribute received qty across items by aging
      let remaining = quantidade_recebida;
      let atualizados = 0;
      let alocado = 0;
      let movsGeradas = 0;
      let movsFalhas = 0;

      for (const item of sorted) {
        if (remaining <= 0) break;

        const qtySolicitada =
          Number(item.compra_quantidade_solicitada ?? 0) ||
          Number(item.quantidade_pedida ?? 0);
        const jaRecebido = Number(item.compra_quantidade_recebida ?? 0);
        const faltante = Math.max(qtySolicitada - jaRecebido, 0);

        if (faltante <= 0) continue;

        const qtyParaEsteItem = Math.min(remaining, faltante);
        const novoRecebido = jaRecebido + qtyParaEsteItem;
        const todosRecebidos = novoRecebido >= qtySolicitada;

        const updateData: Record<string, unknown> = {
          compra_quantidade_recebida: novoRecebido,
        };

        if (todosRecebidos) {
          updateData.compra_status = "recebido";
        }

        if (observacao) {
          updateData.compra_equivalente_observacao = observacao;
        }

        // [Fix-D #3.8] Optimistic lock via .eq("compra_quantidade_recebida", jaRecebido).
        // Se outro receiver alterou recebida entre o SELECT (linha 116) e este UPDATE,
        // affected_rows=0 e a request refaz o cálculo com qty atualizada (1 retry).
        // Padrão P3 (alinhado com iniciarGuarda, contagens, transferencias).
        const { data: updated, error: updateErr } = await supabase
          .from("siso_pedido_itens")
          .update(updateData)
          .eq("id", item.id)
          .eq("compra_quantidade_recebida", jaRecebido)
          .select("id");

        if (updateErr) {
          logger.error("compras-receber", `Erro ao atualizar item ${item.id}`, {
            error: updateErr.message,
          });
          continue;
        }

        if (!updated || updated.length === 0) {
          // Race detectada: refetch o item, recalcula faltante, tenta 1x mais
          const { data: refresh } = await supabase
            .from("siso_pedido_itens")
            .select(
              "id, pedido_id, sku, compra_quantidade_solicitada, quantidade_pedida, compra_quantidade_recebida",
            )
            .eq("id", item.id)
            .single();
          if (!refresh) {
            logger.warn("compras-receber", "Item desapareceu durante race retry", {
              id: item.id,
            });
            continue;
          }
          const novoJaRecebido = Number(refresh.compra_quantidade_recebida ?? 0);
          const novoFaltante = Math.max(qtySolicitada - novoJaRecebido, 0);
          if (novoFaltante <= 0) {
            // Outro receiver já completou — pula sem consumir do `remaining`
            logger.info("compras-receber", "Race resolveu pra outro receiver", {
              id: item.id,
            });
            continue;
          }
          const novaQtyParaEsteItem = Math.min(remaining, novoFaltante);
          const novoTotal = novoJaRecebido + novaQtyParaEsteItem;
          const novoTodosRecebidos = novoTotal >= qtySolicitada;
          const novoUpdateData: Record<string, unknown> = {
            compra_quantidade_recebida: novoTotal,
          };
          if (novoTodosRecebidos) novoUpdateData.compra_status = "recebido";
          if (observacao) novoUpdateData.compra_equivalente_observacao = observacao;
          const { data: retryUpdated } = await supabase
            .from("siso_pedido_itens")
            .update(novoUpdateData)
            .eq("id", item.id)
            .eq("compra_quantidade_recebida", novoJaRecebido)
            .select("id");
          if (!retryUpdated || retryUpdated.length === 0) {
            logger.warn("compras-receber", "Race persistente em retry — abandonando item", {
              id: item.id,
            });
            continue;
          }
          allAffectedItemIds.push(String(item.id));
          remaining -= novaQtyParaEsteItem;
          atualizados++;
          alocado += novaQtyParaEsteItem;
          const pedidoIdRetry = item.pedido_id as string;
          const curRetry = eventosPorPedido.get(pedidoIdRetry) ?? { qty: 0, skus: [] };
          curRetry.qty += novaQtyParaEsteItem;
          if (!curRetry.skus.includes(sku)) curRetry.skus.push(sku);
          eventosPorPedido.set(pedidoIdRetry, curRetry);
          continue;
        }

        allAffectedItemIds.push(String(item.id));
        remaining -= qtyParaEsteItem;
        atualizados++;
        alocado += qtyParaEsteItem;

        const pedidoId = item.pedido_id as string;
        const cur = eventosPorPedido.get(pedidoId) ?? { qty: 0, skus: [] };
        cur.qty += qtyParaEsteItem;
        if (!cur.skus.includes(sku)) cur.skus.push(sku);
        eventosPorPedido.set(pedidoId, cur);

        // Grava mov E no ledger (entrada na loc RECEBIMENTO do galpão da OC).
        // Failure isolada — não quebra o loop, apenas marca o pedido pra alerta.
        try {
          const pedidoMeta = item.siso_pedidos as {
            empresa_origem_id?: string | null;
            separacao_galpao_id?: string | null;
          } | null;
          await gravarMovEntradaCompra({
            supabase,
            sku,
            pedido_id: String(item.pedido_id),
            pedido_item_id: String(item.id),
            qty: qtyParaEsteItem,
            empresa_origem_id: pedidoMeta?.empresa_origem_id ?? null,
            separacao_galpao_id: pedidoMeta?.separacao_galpao_id ?? null,
            fornecedor_nome:
              (item as { fornecedor_oc?: string | null }).fornecedor_oc ??
              null,
            custo_unitario: custo_unitario ?? 0,
            nota_fiscal_id: nota_fiscal_id ?? null,
            usuario_id: session.id,
          });
          movsGeradas++;
        } catch (movErr) {
          movsFalhas++;
          logger.error(
            "compras-receber",
            `Falha ao gravar mov E nf_compra pra item ${item.id}`,
            {
              error: movErr instanceof Error ? movErr.message : String(movErr),
              pedido_id: item.pedido_id,
              sku,
              qty: qtyParaEsteItem,
            },
          );
          // Best-effort: marca o pedido pra alerta. Se a coluna não existir
          // ou o update falhar, segue em frente — não é fatal.
          try {
            await supabase
              .from("siso_pedidos")
              .update({ compra_estoque_lancado_alerta: true })
              .eq("id", item.pedido_id);
          } catch {
            // ignora — coluna pode não existir em todos ambientes
          }
        }
      }

      recebimentoLog.push({
        sku,
        itens_atualizados: atualizados,
        quantidade_alocada: alocado,
        movs_geradas: movsGeradas,
        movs_falhas: movsFalhas,
      });
    }

    // Check which pedidos are now fully received and can be released
    const pedidosDesbloqueados = await checkAndReleasePedidos(allAffectedItemIds);

    // Audit trail: 1 evento compra_item_recebido por pedido afetado.
    if (eventosPorPedido.size > 0) {
      await registrarEventos(
        Array.from(eventosPorPedido.entries()).map(([pedidoId, info]) => ({
          pedidoId,
          evento: "compra_item_recebido" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: {
            qty_total: info.qty,
            skus: info.skus,
          },
        })),
      );
    }

    logger.info("compras-receber", "Recebimento confirmado", {
      usuario: session.nome,
      total_skus: recebimentoLog.length,
      total_itens: recebimentoLog.reduce((s, r) => s + r.itens_atualizados, 0),
      pedidos_desbloqueados: pedidosDesbloqueados.length,
      movs_geradas: recebimentoLog.reduce((s, r) => s + r.movs_geradas, 0),
      movs_falhas: recebimentoLog.reduce((s, r) => s + r.movs_falhas, 0),
    });

    return NextResponse.json({
      ok: true,
      recebimento: recebimentoLog,
      pedidos_desbloqueados: pedidosDesbloqueados,
    });
  } catch (err) {
    logger.error("compras-receber", "Erro ao processar recebimento", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro interno ao processar recebimento" },
      { status: 500 },
    );
  }
}

/**
 * Grava mov E (origem_tipo='nf_compra') no ledger pro recebimento de uma OC.
 *
 * Resolve:
 * - Galpão: separacao_galpao_id (preferido) ou galpão preferencial da
 *   empresa_origem_id (geo-priority 0).
 * - Produto WMS uuid: via siso_produto_empresas JOIN
 *   (empresa_id=empresa_origem_id, tiny_produto_id=item.produto_id) —
 *   mas como o item já tem `sku`, basta resolver pelo sku.
 * - Loc RECEBIMENTO: primeira `siso_localizacoes WHERE galpao_id=X
 *   AND tipo='recebimento' AND ativo=true`.
 * - Fornecedor: best-effort lookup por nome (item.fornecedor_oc).
 *
 * Critical: `pedido_id` em siso_pedidos é text (bigint stringificado do Tiny),
 * NÃO é uuid. Passamos via `origem_id` + `origem_detalhes.pedido_id_tiny` —
 * NÃO via `inserirMovimentacao({ pedido_id })` que validaria como uuid.
 */
async function gravarMovEntradaCompra(args: {
  supabase: ReturnType<typeof createServiceClient>;
  sku: string;
  pedido_id: string;
  pedido_item_id: string;
  qty: number;
  empresa_origem_id: string | null;
  separacao_galpao_id: string | null;
  fornecedor_nome: string | null;
  custo_unitario: number;
  nota_fiscal_id: string | null;
  usuario_id: string;
}): Promise<void> {
  const {
    supabase,
    sku,
    pedido_id,
    pedido_item_id,
    qty,
    empresa_origem_id,
    separacao_galpao_id,
    fornecedor_nome,
    custo_unitario,
    nota_fiscal_id,
    usuario_id,
  } = args;

  // 1) Resolve produto WMS uuid via sku (catálogo unificado).
  const { data: produto } = await supabase
    .from("siso_produtos")
    .select("id")
    .eq("sku", sku)
    .maybeSingle();
  const produtoId = (produto as { id?: string } | null)?.id;
  if (!produtoId) {
    throw new Error(`produto ${sku} não encontrado em siso_produtos`);
  }

  const custoResolvido = await resolverCustoEntrada({
    produto_id: produtoId,
    custo_informado: custo_unitario,
  });

  // 2) Resolve galpão: separacao_galpao_id (preferido) ou preferencial
  //    de empresa_origem_id (geo-priority 0).
  let galpaoId: string | null = separacao_galpao_id ?? null;
  if (!galpaoId && empresa_origem_id) {
    const { data: pref } = await supabase
      .from("siso_empresa_galpoes_preferenciais")
      .select("galpao_id")
      .eq("empresa_id", empresa_origem_id)
      .limit(1)
      .maybeSingle();
    galpaoId = (pref as { galpao_id?: string } | null)?.galpao_id ?? null;
  }
  if (!galpaoId) {
    throw new Error(
      `não foi possível resolver galpão pro pedido ${pedido_id} (separacao_galpao_id=null e empresa_origem_id sem preferencial)`,
    );
  }

  // 3) Resolve loc RECEBIMENTO do galpão.
  const { data: loc } = await supabase
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("tipo", "recebimento")
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  const locId = (loc as { id?: string } | null)?.id;
  if (!locId) {
    throw new Error(
      `galpão ${galpaoId} sem loc tipo='recebimento' ativa — semear DEFAULT-RECEBIMENTO`,
    );
  }

  // 4) Best-effort: resolve fornecedor_id por nome (item.fornecedor_oc).
  let fornecedorId: string | null = null;
  if (fornecedor_nome) {
    const { data: forn } = await supabase
      .from("siso_fornecedores")
      .select("id")
      .eq("nome", fornecedor_nome)
      .maybeSingle();
    fornecedorId = (forn as { id?: string } | null)?.id ?? null;
  }

  // 5) Insere mov E no ledger.
  //
  // CRITICAL: `pedido_id` em siso_pedidos é text (bigint stringificado do
  // Tiny, ex: "9034989457"), NÃO uuid. O validador de `inserirMovimentacao`
  // rejeitaria via assertUuidLike. Passamos via `origem_id` (que é text por
  // design no ledger) + `origem_detalhes.pedido_id_tiny` pra preservar
  // rastreabilidade.
  await inserirMovimentacao({
    tripla: {
      produto_id: produtoId,
      galpao_id: galpaoId,
      localizacao_id: locId,
    },
    tipo: "E",
    qty,
    origem_tipo: "nf_compra",
    origem_id: pedido_id,
    origem_detalhes: {
      sku,
      pedido_item_id,
      fornecedor_nome,
      pedido_id_tiny: pedido_id,
    },
    empresa_compradora_id: empresa_origem_id ?? null,
    fornecedor_id: fornecedorId,
    nota_fiscal_id: nota_fiscal_id ?? null,
    custo_unitario: custoResolvido,
    motivo: `Recebimento OC — pedido ${pedido_id}`,
    usuario_id,
  });
}
