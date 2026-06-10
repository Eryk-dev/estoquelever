/**
 * Handler de cancelamento de pedido (Tiny → SISO).
 *
 * Extraído de api/wms/webhook/tiny/route.ts pra ser compartilhado entre o
 * webhook receiver e o polling fallback (tiny-polling.ts). Lógica idêntica:
 * libera reservas R per-R, limpa fluxo de compras, cancela fila de execução
 * e marca o pedido como cancelado.
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";
import { estornarReservaIndividual } from "./wms/reservas";

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
    .select("id, status, status_separacao")
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

    const cancelUpdate: Record<string, unknown> = {
      status: "cancelado",
      processado_em: new Date().toISOString(),
    };
    if (existingOrder.status_separacao != null) {
      cancelUpdate.status_separacao = null;
    }

    // --- Compras cleanup ---
    const isInComprasFlow =
      existingOrder.status_separacao === "aguardando_compra" ||
      existingOrder.status_separacao === "comprado";

    if (isInComprasFlow) {
      // Fetch items with compra data
      const { data: compraItems } = await supabase
        .from("siso_pedido_itens")
        .select("id, sku, ordem_compra_id, compra_status, compra_quantidade_recebida")
        .eq("pedido_id", pedidoId)
        .not("compra_status", "is", null);

      if (compraItems && compraItems.length > 0) {
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

        // Collect distinct OC IDs before clearing
        const affectedOcIds = [
          ...new Set(
            compraItems
              .map((item) => item.ordem_compra_id)
              .filter((id): id is string => id != null)
          ),
        ];

        // Clear compra fields on all items
        await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: null,
            ordem_compra_id: null,
          })
          .eq("pedido_id", pedidoId)
          .not("compra_status", "is", null);

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
    }
    // --- End compras cleanup ---

    await supabase
      .from("siso_pedidos")
      .update(cancelUpdate)
      .eq("id", pedidoId);

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
      hadComprasCleanup: isInComprasFlow,
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
