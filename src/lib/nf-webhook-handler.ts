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
