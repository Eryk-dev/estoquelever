/**
 * Reconciliation service — catches orders lost due to webhook failures.
 *
 * Phase 1: Reprocess stuck webhook_logs (status=processando > 5 min)
 * Phase 2: Query Tiny for approved orders not in siso_pedidos
 *
 * Used by:
 * - GET /api/reconciliacao (on-demand)
 * - instrumentation.ts (polling every 20 min)
 */

import { createServiceClient } from "./supabase-server";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { listarPedidos } from "./tiny-api";
import { processWebhook } from "./webhook-processor";
import { getEmpresaById } from "./empresa-lookup";
import { logger } from "./logger";

const LOG_SOURCE = "reconciliacao";

/** Max age (ms) for a webhook_log in "processando" before we consider it stuck */
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface ReconciliacaoResult {
  stuckWebhooks: {
    pedidoId: string;
    empresaId: string;
    stuckSince: string;
    reprocessed: boolean;
    error?: string;
  }[];
  missingOrders: {
    pedidoId: string;
    empresaId: string;
    numero: string;
    reprocessed: boolean;
    error?: string;
  }[];
  summary: {
    stuckFound: number;
    missingFound: number;
    totalReprocessed: number;
    dryRun: boolean;
    lookbackHours: number;
  };
}

export async function reconciliar(opts: {
  lookbackHours?: number;
  dryRun?: boolean;
}): Promise<ReconciliacaoResult> {
  const lookbackHours = opts.lookbackHours ?? 48;
  const dryRun = opts.dryRun ?? false;

  const supabase = createServiceClient();
  const results: ReconciliacaoResult = {
    stuckWebhooks: [],
    missingOrders: [],
    summary: { stuckFound: 0, missingFound: 0, totalReprocessed: 0, dryRun, lookbackHours },
  };

  // ─── Phase 1: Reprocess stuck webhook_logs ────────────────────────────────

  const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();

  const { data: stuckLogs } = await supabase
    .from("siso_webhook_logs")
    .select("id, tiny_pedido_id, empresa_id, criado_em")
    .eq("status", "processando")
    .lt("criado_em", stuckCutoff)
    .in("tipo", ["atualizacao_pedido", "inclusao_pedido"]);

  if (stuckLogs && stuckLogs.length > 0) {
    logger.info(LOG_SOURCE, `Found ${stuckLogs.length} stuck webhook(s)`, {
      pedidoIds: stuckLogs.map((l) => l.tiny_pedido_id),
    });

    for (const log of stuckLogs) {
      const empresaId = log.empresa_id as string | null;
      if (!empresaId) {
        results.stuckWebhooks.push({
          pedidoId: log.tiny_pedido_id,
          empresaId: "unknown",
          stuckSince: log.criado_em,
          reprocessed: false,
          error: "Missing empresa_id",
        });
        continue;
      }

      if (dryRun) {
        results.stuckWebhooks.push({
          pedidoId: log.tiny_pedido_id,
          empresaId,
          stuckSince: log.criado_em,
          reprocessed: false,
        });
        continue;
      }

      try {
        // Reset webhook_log status so processWebhook can update it
        await supabase
          .from("siso_webhook_logs")
          .update({ status: "processando", processado_em: null, erro: null })
          .eq("id", log.id);

        const empresa = await getEmpresaById(empresaId);
        if (!empresa) throw new Error("Empresa not found");

        await processWebhook(
          log.id,
          log.tiny_pedido_id,
          empresa.empresaId,
          empresa.galpaoId,
          empresa.grupoId,
        );

        results.stuckWebhooks.push({
          pedidoId: log.tiny_pedido_id,
          empresaId,
          stuckSince: log.criado_em,
          reprocessed: true,
        });

        logger.info(LOG_SOURCE, "Reprocessed stuck webhook", {
          pedidoId: log.tiny_pedido_id,
          empresaId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.stuckWebhooks.push({
          pedidoId: log.tiny_pedido_id,
          empresaId,
          stuckSince: log.criado_em,
          reprocessed: false,
          error: msg,
        });
        logger.error(LOG_SOURCE, "Failed to reprocess stuck webhook", {
          pedidoId: log.tiny_pedido_id,
          empresaId,
          error: msg,
        });
      }
    }
  }

  // ─── Phase 2: Query Tiny for approved orders not in siso_pedidos ──────────

  const { data: connections } = await supabase
    .from("siso_tiny_connections")
    .select("empresa_id")
    .eq("ativo", true);

  if (connections && connections.length > 0) {
    const dataInicial = new Date(Date.now() - lookbackHours * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const dataFinal = new Date().toISOString().split("T")[0];

    for (const conn of connections) {
      const empresaId = conn.empresa_id as string;
      if (!empresaId) continue;

      const empresa = await getEmpresaById(empresaId);
      if (!empresa) continue;

      try {
        const { token } = await getValidTokenByEmpresa(empresaId);

        // Fetch orders from Tiny in multiple situacoes
        const allTinyPedidos: { id: string; numero: string }[] = [];

        // Tiny v3 situacao codes: 3=Aprovada, 4=Preparando Envio, 1=Faturada
        for (const situacao of [3, 4, 1]) {
          let offset = 0;
          const limit = 100;

          while (true) {
            const res = await runWithEmpresa(empresaId, () =>
              listarPedidos(token, {
                situacao,
                dataInicialEmissao: dataInicial,
                dataFinalEmissao: dataFinal,
                limit,
                offset,
              }),
            );

            const itens = res.itens ?? [];
            for (const item of itens) {
              // Skip non-marketplace orders (no ecommerce = internal/manual Tiny order)
              if (!item.ecommerce?.nome && !item.ecommerce?.numeroPedidoEcommerce) {
                continue;
              }
              allTinyPedidos.push({
                id: String(item.id),
                numero: String(item.numeroPedido),
              });
            }

            if (itens.length < limit) break;
            offset += limit;
            if (offset >= 500) break; // Safety cap
          }
        }

        if (allTinyPedidos.length === 0) continue;

        // Check which are missing from siso_pedidos
        const tinyIds = allTinyPedidos.map((p) => p.id);
        const { data: existingPedidos } = await supabase
          .from("siso_pedidos")
          .select("id")
          .in("id", tinyIds);

        const existingIds = new Set((existingPedidos ?? []).map((p) => p.id));

        // Exclude those with active/handled webhook_logs (handled in Phase 1, already OK, or ignored)
        const { data: activeWebhooks } = await supabase
          .from("siso_webhook_logs")
          .select("tiny_pedido_id")
          .in("tiny_pedido_id", tinyIds)
          .in("status", ["processando", "concluido", "ignorado"]);

        const activeWebhookIds = new Set(
          (activeWebhooks ?? []).map((w) => w.tiny_pedido_id),
        );

        const missing = allTinyPedidos.filter(
          (p) => !existingIds.has(p.id) && !activeWebhookIds.has(p.id),
        );

        for (const pedido of missing) {
          if (dryRun) {
            results.missingOrders.push({
              pedidoId: pedido.id,
              empresaId,
              numero: pedido.numero,
              reprocessed: false,
            });
            continue;
          }

          try {
            const { data: logEntry } = await supabase
              .from("siso_webhook_logs")
              .insert({
                tiny_pedido_id: pedido.id,
                cnpj: "",
                tipo: "reconciliacao",
                codigo_situacao: "aprovado",
                empresa_id: empresaId,
                payload: { source: "reconciliacao", pedidoId: pedido.id },
              })
              .select("id")
              .single();

            if (!logEntry) {
              results.missingOrders.push({
                pedidoId: pedido.id,
                empresaId,
                numero: pedido.numero,
                reprocessed: false,
                error: "Failed to create webhook_log",
              });
              continue;
            }

            await processWebhook(
              logEntry.id,
              pedido.id,
              empresa.empresaId,
              empresa.galpaoId,
              empresa.grupoId,
            );

            results.missingOrders.push({
              pedidoId: pedido.id,
              empresaId,
              numero: pedido.numero,
              reprocessed: true,
            });

            logger.info(LOG_SOURCE, "Reconciled missing order", {
              pedidoId: pedido.id,
              numero: pedido.numero,
              empresaId,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.missingOrders.push({
              pedidoId: pedido.id,
              empresaId,
              numero: pedido.numero,
              reprocessed: false,
              error: msg,
            });
            logger.error(LOG_SOURCE, "Failed to reconcile missing order", {
              pedidoId: pedido.id,
              empresaId,
              error: msg,
            });
          }
        }
      } catch (err) {
        logger.error(LOG_SOURCE, `Failed to check empresa ${empresa.empresaNome}`, {
          empresaId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────

  results.summary.stuckFound = results.stuckWebhooks.length;
  results.summary.missingFound = results.missingOrders.length;
  results.summary.totalReprocessed = [
    ...results.stuckWebhooks.filter((w) => w.reprocessed),
    ...results.missingOrders.filter((o) => o.reprocessed),
  ].length;

  const total = results.summary.stuckFound + results.summary.missingFound;
  if (total > 0) {
    logger.info(LOG_SOURCE, "Reconciliation complete", {
      ...results.summary,
    });
  }

  return results;
}
