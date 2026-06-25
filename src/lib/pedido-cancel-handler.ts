/**
 * Handler de cancelamento de pedido (Tiny → SISO).
 *
 * Extraído de api/wms/webhook/tiny/route.ts pra ser compartilhado entre o
 * webhook receiver e o polling fallback (tiny-polling.ts). Lógica idêntica:
 * libera reservas R per-R, limpa fluxo de compras, cancela fila de execução
 * e marca o pedido como cancelado.
 *
 * CST-02 — semântica de picks (espelha o caminho humano D1/P007 de
 * separacao/cancelar + cancelarVendaManual): a S dos itens já pegos NÃO é
 * estornada (a peça saiu da prateleira de verdade — estorno automático
 * mentiria sobre o físico). Os pegos viram pendência de devolução MANUAL:
 * evento 'cancelado' no histórico com a lista (qty + sku) + tag
 * 'cancelado_com_picks' em separacao_tags pra rastreio.
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";
import { estornarReservaIndividual } from "./wms/reservas";
import { estornarMovimentacao } from "./wms/ledger";
import { cancelarTrocasPendentesDoPedido } from "./wms/trocas-equivalencia";
import { classificarItensParaCancelamento } from "./wms/cancelamento-parcial";
import { registrarPicksCanceladosParaDevolucao } from "./wms/devolucoes";
import { registrarEvento } from "./historico-service";
import { TAG_FUTURA } from "./wms/separacao-futura";
import { camposCancelamento } from "./wms/cancelamento-fields";

/** Usuário "Sistema (automação)" — carimba estornos automáticos. */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export interface CancelamentoResult {
  status: "cancelled" | "cancelled_unknown";
  previousStatus?: string | null;
}

export async function handlePedidoCancelamento(params: {
  pedidoId: string;
  webhookLogId: string;
  empresaId: string;
}): Promise<CancelamentoResult> {
  const { pedidoId, webhookLogId, empresaId } = params;
  const supabase = createServiceClient();

  const { data: existingOrder } = await supabase
    .from("siso_pedidos")
    .select("id, status, status_separacao, estoque_lancado, separacao_tags, separacao_futura")
    .eq("id", pedidoId)
    .single();

  if (existingOrder) {
    // PR-1 (#1.1): libera Rs do pedido cancelado per-R via
    // `estornarReservaIndividual` pra evitar o short-circuit global de
    // `liberarReserva` (ver fix #2.9 em encaminhar). Sem isso, R fica
    // zumbi consumindo "reservado" em siso_estoque até o cron de cleanup
    // (expira_em). Próximo pedido pro mesmo SKU degrada pra OC
    // erroneamente porque `disponivel = saldo - reservado` fica baixo.
    //
    // Idempotente por R (acha L com estorno_de=R.id antes de criar novo),
    // então seguro chamar pra TODAS as Rs do pedido — as já liberadas por
    // picking retornam o L existente sem criar mov nova.
    try {
      const { data: reservasAbertas } = await supabase
        .from("siso_movimentacoes")
        .select("id")
        .eq("tipo", "R")
        .eq("origem_tipo", "reserva_pedido")
        .eq("origem_id", String(pedidoId));
      const lista = (reservasAbertas ?? []) as Array<{ id: string }>;
      let liberadas = 0;
      for (const r of lista) {
        try {
          await estornarReservaIndividual({
            reserva_id: r.id,
            motivo: "outro",
            // webhook é system-initiated; sem usuário operador
          });
          liberadas++;
        } catch (e) {
          logger.warn("webhook", "falha estornando R individual (segue)", {
            pedidoId,
            reserva_id: r.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      logger.info("webhook", "Rs liberadas no cancelamento", {
        pedidoId,
        liberadas,
        tentadas: lista.length,
      });
    } catch (e) {
      logger.warn("webhook", "falha liberando Rs no cancel (segue)", {
        pedidoId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Troca de equivalência: solicitação pendente carrega R forte
    // (origem_tipo='reserva_troca') que o loop acima NÃO cobre — encerra as
    // trocas pendentes do pedido pra devolver o disponivel do substituto.
    try {
      const canceladas = await cancelarTrocasPendentesDoPedido({
        pedidoId: String(pedidoId),
        usuarioId: null,
        motivo: "pedido cancelado",
      });
      if (canceladas > 0) {
        logger.info("webhook", "trocas pendentes canceladas no cancelamento", {
          pedidoId,
          canceladas,
        });
      }
    } catch (e) {
      logger.warn("webhook", "falha cancelando trocas pendentes (segue)", {
        pedidoId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const cancelUpdate: Record<string, unknown> = {
      status: "cancelado",
      processado_em: new Date().toISOString(),
      // Tiny não manda motivo no cancelamento do cliente → rótulo genérico.
      ...camposCancelamento("cliente", "Cancelado pelo cliente (marketplace)"),
    };
    if (existingOrder.status_separacao != null) {
      cancelUpdate.status_separacao = null;
    }

    // Itens lidos uma vez — servem o tratamento de picks (CST-02) e a
    // limpeza do fluxo de compras (CST-03).
    const { data: itensRaw } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, sku, quantidade_pedida, quantidade_pega, mov_saida_id, ordem_compra_id, compra_status, compra_quantidade_recebida",
      )
      .eq("pedido_id", pedidoId);
    const itens = (itensRaw ?? []) as Array<{
      id: string;
      sku: string | null;
      quantidade_pedida: number | null;
      quantidade_pega: number | null;
      mov_saida_id: string | null;
      ordem_compra_id: string | null;
      compra_status: string | null;
      compra_quantidade_recebida: number | null;
    }>;

    // --- CST-02: picks / estoque lançado → devolução manual ---
    // Espelha o caminho humano (D1/P007): NÃO estorna a S dos itens pegos
    // (auditoria — a saída física aconteceu); registra evento + tag pra um
    // operador resolver a devolução manualmente.
    const { pegos } = classificarItensParaCancelamento(
      itens.map((i) => ({
        id: String(i.id),
        sku: i.sku ?? null,
        mov_saida_id: i.mov_saida_id ?? null,
        quantidade_pega: i.quantidade_pega ?? null,
      })),
    );
    const estoqueLancado = existingOrder.estoque_lancado === true;
    const pegosIds = new Set(pegos.map((p) => p.id));

    // --- SEPARAÇÃO FUTURA (Fase 8): a peça picada de uma futura está na CAIXA DO
    // DIA (não foi expedida — não tem NF nem etiqueta). Cancelou → estorna a S e
    // devolve à prateleira (re-trabalho aceito), SEM devolução manual. (Reservas
    // não-picadas já foram liberadas no loop de R acima.) Strip da tag FUTURA.
    if (existingOrder.separacao_futura === true) {
      const picadosFutura = itens.filter(
        (i) => i.mov_saida_id && Number(i.quantidade_pega ?? 0) > 0,
      );
      for (const it of picadosFutura) {
        try {
          await estornarMovimentacao({
            mov_id: it.mov_saida_id as string,
            usuario_id: SYSTEM_USER_ID,
            motivo: "futura cancelada — peça volta à prateleira",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Idempotente: re-entrega do cancelamento acha a S já estornada.
          if (!/já foi estornada|já é um estorno/i.test(msg)) {
            logger.warn("webhook", "falha estornando S de futura cancelada (segue)", {
              pedidoId,
              mov_saida_id: it.mov_saida_id,
              error: msg,
            });
          }
        }
      }
      const tagsFutura: string[] = (existingOrder.separacao_tags as string[] | null) ?? [];
      if (tagsFutura.includes(TAG_FUTURA)) {
        cancelUpdate.separacao_tags = tagsFutura.filter((t) => t !== TAG_FUTURA);
      }
      if (picadosFutura.length > 0) {
        registrarEvento({
          pedidoId,
          evento: "cancelado",
          detalhes: {
            origem: "webhook_cancelamento",
            modo: "futura_cancelada",
            itens_estornados: picadosFutura.length,
          },
        }).catch(() => {});
        logger.info("webhook", "futura cancelada — S estornada, peça volta à prateleira", {
          pedidoId,
          itens_estornados: picadosFutura.length,
        });
      }
    }

    // estoque_lancado=true sem marker per-item (S veio do cutover/pos-NF, não
    // do pick — ex.: pedido em separado/embalado): TODOS os itens já saíram
    // no ledger → todos entram na lista de devolução manual.
    // Futura é tratada acima (auto-estorno) → não entra na devolução manual.
    const baseDevolucao =
      existingOrder.separacao_futura === true
        ? []
        : pegos.length > 0
          ? itens.filter((i) => pegosIds.has(String(i.id)))
          : estoqueLancado
            ? itens
            : [];
    const itensDevolucaoManual = baseDevolucao.map((i) => ({
      id: String(i.id),
      sku: i.sku ?? null,
      qty: Number(i.quantidade_pega ?? i.quantidade_pedida ?? 0),
    }));

    if (itensDevolucaoManual.length > 0) {
      const currentTags: string[] =
        (existingOrder.separacao_tags as string[] | null) ?? [];
      if (!currentTags.includes("cancelado_com_picks")) {
        cancelUpdate.separacao_tags = [...currentTags, "cancelado_com_picks"];
      }
      // BUG-12: pendência FORTE de devolução por item pego (S rastreável via
      // mov_saida_id) → worklist + retorno ao estoque ao classificar 'integro'.
      // Itens lançados sem marker per-item (S de cutover, mov_saida_id null)
      // não entram aqui — só o caminho de pick rastreável.
      await registrarPicksCanceladosParaDevolucao(
        baseDevolucao
          .filter((i) => i.mov_saida_id)
          .map((i) => ({
            pedido_id: pedidoId,
            mov_saida_id: i.mov_saida_id as string,
            sku: i.sku ?? null,
            qty: Number(i.quantidade_pega ?? i.quantidade_pedida ?? 0),
          })),
      );
    }
    // --- End CST-02 ---

    // --- Compras cleanup ---
    // CST-03: limpeza baseada nos ITENS, não no status do pedido. O gate
    // antigo (status_separacao ∈ {aguardando_compra, comprado}) deixava itens
    // vivos na tela de compras quando o pedido estava em validacao_oc (item
    // 'oc_pendente') ou em_separacao (pedido misto com item
    // 'aguardando_compra') → comprador comprava pra pedido morto. Qualquer
    // item com compra_status ATIVO recebe a limpeza; 'recebido'/'cancelado'
    // (resolvidos) são preservados como histórico — item 'recebido' mantém o
    // vínculo com a OC (a entrega aconteceu).
    const COMPRA_STATUS_ATIVO = [
      "oc_pendente",
      "aguardando_compra",
      "comprado",
      "indisponivel",
      "equivalente_pendente",
      "cancelamento_pendente",
    ];
    const compraItems = itens.filter((i) => i.compra_status != null);
    const itensCompraAtivos = compraItems.filter((i) =>
      COMPRA_STATUS_ATIVO.includes(i.compra_status as string),
    );

    if (itensCompraAtivos.length > 0) {
      // Check if any item had stock already entered in Tiny
      const itemsComEstoqueLancado = compraItems.filter(
        (item) => (item.compra_quantidade_recebida ?? 0) > 0
      );

      if (itemsComEstoqueLancado.length > 0) {
        cancelUpdate.compra_estoque_lancado_alerta = true;

        for (const item of itemsComEstoqueLancado) {
          logger.warn("webhook", "Cancelled pedido had stock already entered in Tiny", {
            pedidoId,
            sku: item.sku,
            quantidade_ja_lancada: item.compra_quantidade_recebida,
          });
        }
      }

      // Collect distinct OC IDs before clearing (só dos itens ativos)
      const affectedOcIds = [
        ...new Set(
          itensCompraAtivos
            .map((item) => item.ordem_compra_id)
            .filter((id): id is string => id != null)
        ),
      ];

      // Clear compra fields nos itens com fluxo de compras ativo
      await supabase
        .from("siso_pedido_itens")
        .update({
          compra_status: null,
          ordem_compra_id: null,
        })
        .eq("pedido_id", pedidoId)
        .in("compra_status", COMPRA_STATUS_ATIVO);

      // Check each affected OC — cancel if empty
      for (const ocId of affectedOcIds) {
        const { count } = await supabase
          .from("siso_pedido_itens")
          .select("id", { count: "exact", head: true })
          .eq("ordem_compra_id", ocId);

        if (count === 0) {
          await supabase
            .from("siso_ordens_compra")
            .update({ status: "cancelado" })
            .eq("id", ocId);

          logger.info("webhook", "OC cancelled (no remaining items after pedido cancellation)", {
            ocId,
            pedidoId,
          });
        }
      }
    }
    // --- End compras cleanup ---

    await supabase
      .from("siso_pedidos")
      .update(cancelUpdate)
      .eq("id", pedidoId);

    // CST-02: visibilidade — evento no histórico com a lista de itens pegos.
    // Guard por status anterior evita evento duplicado em re-entrega do
    // webhook (handler é idempotente no resto).
    if (itensDevolucaoManual.length > 0 && existingOrder.status !== "cancelado") {
      registrarEvento({
        pedidoId,
        evento: "cancelado",
        detalhes: {
          origem: "webhook_cancelamento",
          modo: "cancelado_com_picks",
          estoque_lancado: estoqueLancado,
          itens_devolucao_manual: itensDevolucaoManual,
        },
      }).catch(() => {});
      logger.warn("webhook", "Pedido cancelado com saída física — devolução manual pendente", {
        pedidoId,
        itens_devolucao_manual: itensDevolucaoManual.length,
        estoque_lancado: estoqueLancado,
      });
    }

    await supabase
      .from("siso_fila_execucao")
      .update({
        status: "cancelado",
        atualizado_em: new Date().toISOString(),
      })
      .eq("pedido_id", pedidoId)
      .eq("status", "pendente");

    await supabase
      .from("siso_webhook_logs")
      .update({ status: "concluido", processado_em: new Date().toISOString() })
      .eq("id", webhookLogId);

    logger.info("webhook", "Order cancelled", {
      pedidoId,
      empresaId,
      previousStatus: existingOrder.status,
      hadComprasCleanup: itensCompraAtivos.length > 0,
      itensDevolucaoManual: itensDevolucaoManual.length,
    });

    return { status: "cancelled", previousStatus: existingOrder.status };
  }

  await supabase
    .from("siso_webhook_logs")
    .update({ status: "concluido", processado_em: new Date().toISOString() })
    .eq("id", webhookLogId);

  logger.info("webhook", "Cancellation received for unknown order", {
    pedidoId,
    empresaId,
  });

  return { status: "cancelled_unknown" };
}
