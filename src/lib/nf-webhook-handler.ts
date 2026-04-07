/**
 * Handler for Tiny webhook tipo "nota_fiscal".
 *
 * When a NF is authorized by SEFAZ, Tiny sends this webhook.
 * We match the NF to an existing pedido and transition it
 * from aguardando_nf → aguardando_separacao, saving DANFE URL and chave de acesso.
 */

import { createServiceClient } from "./supabase-server";
import { obterNotaFiscal } from "./tiny-api";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { logger } from "./logger";
import { registrarEvento } from "./historico-service";
import { criarAgrupamentoFase1 } from "./agrupamento-service";
import { kickWorker } from "./execution-worker";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NfWebhookPayload {
  cnpj: string;
  tipo: string;
  dados: {
    idNotaFiscalTiny: number;
    numero?: string;
    serie?: string;
    urlDanfe?: string;
    chaveAcesso?: string;
    dataEmissao?: string;
    valorNota?: number;
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleNfWebhook(
  payload: NfWebhookPayload,
  empresaId: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { idNotaFiscalTiny, urlDanfe, chaveAcesso } = payload.dados;
  // Step 1 — Dedup via siso_webhook_logs unique index on dedup_key (generated column)
  const { data: logEntry, error: insertError } = await supabase
    .from("siso_webhook_logs")
    .insert({
      tiny_pedido_id: String(idNotaFiscalTiny),
      cnpj: payload.cnpj,
      tipo: "nota_fiscal",
      empresa_id: empresaId,
      payload: payload as unknown as Record<string, unknown>,
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      logger.info("nf-webhook", "Duplicate NF webhook ignored", {
        idNotaFiscalTiny: String(idNotaFiscalTiny),
        empresaId,
      });
      return;
    }
    logger.error("nf-webhook", "Failed to insert webhook log", {
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
      error: insertError.message,
    });
    throw new Error(`Failed to insert NF webhook log: ${insertError.message}`);
  }

  const webhookLogId = logEntry.id;

  // Step 2 — Fast-path match: pedido already has nota_fiscal_id saved
  const { data: pedidoFastPath } = await supabase
    .from("siso_pedidos")
    .select("id, status_separacao")
    .eq("nota_fiscal_id", idNotaFiscalTiny)
    .single();

  let pedidoId: string | null = pedidoFastPath?.id ?? null;

  // Step 3 — Fallback match: call Tiny API to resolve NF → pedido
  if (!pedidoId) {
    try {
      const { token } = await getValidTokenByEmpresa(empresaId);
      const nf = await runWithEmpresa(empresaId, () =>
        obterNotaFiscal(token, idNotaFiscalTiny),
      );

      // Only process sale invoices
      if (nf.origem?.tipo !== "venda") {
        logger.info("nf-webhook", "NF is not from a sale — ignoring", {
          idNotaFiscalTiny: String(idNotaFiscalTiny),
          origemTipo: nf.origem?.tipo ?? "unknown",
          empresaId,
        });
        await supabase
          .from("siso_webhook_logs")
          .update({ status: "ignorado", processado_em: new Date().toISOString() })
          .eq("id", webhookLogId);
        return;
      }

      // Find pedido by the origin order ID (origem.id = pedido_id in Tiny)
      if (nf.origem?.id) {
        const { data: pedidoByOrigem } = await supabase
          .from("siso_pedidos")
          .select("id, status_separacao")
          .eq("id", nf.origem.id)
          .single();

        if (pedidoByOrigem) {
          pedidoId = pedidoByOrigem.id;
        }
      }
    } catch (err) {
      logger.warn("nf-webhook", "Fallback NF lookup failed", {
        idNotaFiscalTiny: String(idNotaFiscalTiny),
        empresaId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 4 — Race condition: NF arrived before pedido was saved
  if (!pedidoId) {
    logger.info("nf-webhook", "No matching pedido found — saving for retry", {
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
    });
    await supabase
      .from("siso_webhook_logs")
      .update({ status: "aguardando_pedido" })
      .eq("id", webhookLogId);
    return;
  }

  // Step 5a — ALWAYS save nota_fiscal_id + NF data regardless of current status
  await supabase
    .from("siso_pedidos")
    .update({
      nota_fiscal_id: String(idNotaFiscalTiny),
      url_danfe: urlDanfe ?? null,
      chave_acesso_nf: chaveAcesso ?? null,
    })
    .eq("id", pedidoId);

  registrarEvento({
    pedidoId,
    evento: "nf_autorizada",
    detalhes: { idNotaFiscalTiny, chaveAcesso },
  }).catch(() => {});

  logger.info("nf-webhook", "NF data saved on pedido", {
    pedidoId,
    idNotaFiscalTiny: String(idNotaFiscalTiny),
    empresaId,
  });

  // Step 5a.1 — Attempt fase-1 agrupamento when both NF fields are now persisted
  // Fire-and-forget: criarAgrupamentoFase1 never throws, and must not block the webhook response
  if (chaveAcesso) {
    criarAgrupamentoFase1(pedidoId).catch(() => {});
  }

  // Step 5b — Transition aguardando_nf → aguardando_separacao (only if in correct status)
  const { data: transitioned } = await supabase
    .from("siso_pedidos")
    .update({ status_separacao: "aguardando_separacao" })
    .eq("id", pedidoId)
    .eq("status_separacao", "aguardando_nf")
    .select("id")
    .maybeSingle();

  if (transitioned) {
    logger.info("nf-webhook", "Pedido transitioned aguardando_nf → aguardando_separacao", {
      pedidoId,
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
    });

    // Enqueue stock posting now that NF is authorized.
    // Reads decisao_final to route to the correct stock handler.
    const { data: pedidoData } = await supabase
      .from("siso_pedidos")
      .select("decisao_final, empresa_origem_id")
      .eq("id", pedidoId)
      .single();

    if (pedidoData && ["propria", "transferencia"].includes(pedidoData.decisao_final ?? "")) {
      // For transferência, empresa_id in the job must be the separacao_galpao empresa
      // (the support empresa that will provide stock). Use the empresa from the
      // original lancar_estoque job if available, otherwise fall back to empresaId.
      let jobEmpresaId = empresaId;
      if (pedidoData.decisao_final === "transferencia") {
        const { data: originalJob } = await supabase
          .from("siso_fila_execucao")
          .select("empresa_id")
          .eq("pedido_id", pedidoId)
          .eq("tipo", "lancar_estoque")
          .eq("decisao", "transferencia")
          .order("criado_em", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (originalJob) jobEmpresaId = originalJob.empresa_id;
      }

      const { error: insertErr } = await supabase.from("siso_fila_execucao").insert({
        pedido_id: pedidoId,
        tipo: "lancar_estoque_pos_nf",
        empresa_id: jobEmpresaId,
        decisao: pedidoData.decisao_final,
        atualizado_em: new Date().toISOString(),
      });

      if (insertErr) {
        logger.logError({
          error: new Error(insertErr.message),
          source: "nf-webhook",
          message: `Falha ao enfileirar lancar_estoque_pos_nf para pedido ${pedidoId}`,
          category: "database",
          pedidoId,
          metadata: { decisao: pedidoData.decisao_final, empresaId: jobEmpresaId, code: insertErr.code },
        });
        return;
      }

      logger.info("nf-webhook", "Job lancar_estoque_pos_nf enfileirado", {
        pedidoId,
        decisao: pedidoData.decisao_final,
        empresaId: jobEmpresaId,
      });

      kickWorker().catch(() => {});
    }
  } else {
    logger.info("nf-webhook", "Pedido not in aguardando_nf — NF saved, transition skipped", {
      pedidoId,
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
    });
  }

  // Step 6 — Mark webhook as processed
  await supabase
    .from("siso_webhook_logs")
    .update({ status: "processado", processado_em: new Date().toISOString() })
    .eq("id", webhookLogId);
}
