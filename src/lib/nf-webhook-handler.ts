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
import { wmsAsSource } from "./wms/flags";
import { dispararCutoverSePronto } from "./wms/cutover";

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

// ─── Devolução detection (single source of truth) ──────────────────────────
/**
 * Detecta se um payload de NF representa devolução.
 *
 * Tiny entrega o tipo de devolução em formas variadas dependendo do canal e
 * do tipo de payload — `tipo` no envelope, `tipoOperacao`/`tipo_operacao`
 * (E = entrada), `tipo_nota`, ou `finalidade` (Tiny v3 carrega 4=devolução
 * em alguns webhooks). Centralizar a checagem aqui evita branches divergentes
 * entre o webhook receiver e o handler.
 */
export function isDevolucao(nf: {
  tipo?: string;
  tipoOperacao?: string;
  finalidade?: string;
  origem?: { tipo?: string | null } | null;
}): boolean {
  if (nf.tipo && nf.tipo.toLowerCase() === "devolucao") return true;
  if (nf.tipoOperacao === "E") return true;
  if (nf.finalidade && /devol/i.test(nf.finalidade)) return true;
  // [Fix-D #6.12] Tiny v3 carrega 'devolucao' em origem.tipo no /notas/{id}
  // (TinyNotaFiscal). Garantir que esse caminho também classifica.
  if (nf.origem?.tipo && nf.origem.tipo.toLowerCase() === "devolucao") return true;
  return false;
}

// ─── upsertNotaFiscal helper (Fix-Final A T6 / R5) ─────────────────────────
/**
 * Garante existência de uma linha em `siso_notas_fiscais` (tabela canônica)
 * e retorna seu UUID. Usado por `classificarDevolucao` e pelo handler de NF
 * de saída antes de chamar `inserirMovimentacao` (que exige uuid em
 * `nota_fiscal_id` por causa da FK adicionada na migration T5).
 *
 * Dedup priorizado:
 * 1. `chave_acesso` quando presente (UNIQUE)
 * 2. `tiny_nota_fiscal_id` como fallback
 * 3. INSERT
 *
 * Race-safe na prática (chave_acesso UNIQUE), mas em race extremo o segundo
 * INSERT estoura 23505 e o caller deve retry — não tentamos handle aqui pra
 * manter código simples; a probabilidade real é desprezível (1 webhook por NF
 * + dedup upstream em siso_webhook_logs).
 */
export type UpsertNfInput = {
  tiny_nota_fiscal_id?: number | string | null;
  chave_acesso?: string | null;
  numero?: string | null;
  serie?: string | null;
  empresa_id?: string | null;
  tipo: "entrada" | "saida";
  raw?: unknown;
};

export async function upsertNotaFiscal(input: UpsertNfInput): Promise<string> {
  const sb = createServiceClient();
  const chave = input.chave_acesso?.trim() || null;
  const tinyId = input.tiny_nota_fiscal_id != null && input.tiny_nota_fiscal_id !== ""
    ? Number(input.tiny_nota_fiscal_id)
    : null;

  if (chave) {
    const { data: existing } = await sb
      .from("siso_notas_fiscais")
      .select("id")
      .eq("chave_acesso", chave)
      .maybeSingle();
    if (existing) return (existing as { id: string }).id;
  }
  if (tinyId != null) {
    const { data: existing } = await sb
      .from("siso_notas_fiscais")
      .select("id")
      .eq("tiny_nota_fiscal_id", tinyId)
      .maybeSingle();
    if (existing) return (existing as { id: string }).id;
  }

  const { data, error } = await sb
    .from("siso_notas_fiscais")
    .insert({
      tiny_nota_fiscal_id: tinyId,
      chave_acesso: chave,
      numero: input.numero ?? null,
      serie: input.serie ?? null,
      empresa_id: input.empresa_id ?? null,
      tipo: input.tipo,
      raw_tiny: (input.raw as Record<string, unknown> | null | undefined) ?? null,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`upsertNotaFiscal falhou: ${error.message}`);
  }
  return (data as { id: string }).id;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleNfWebhook(
  payload: NfWebhookPayload,
  empresaId: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { idNotaFiscalTiny, urlDanfe, chaveAcesso } = payload.dados;

  // Step 0 — Dedup defensivo composto (nota_fiscal_id + chave_acesso) [#P6-6.33]
  // O dedup_key generated cobre tiny_pedido_id+tipo+codigo_situacao. Pra NF, Tiny
  // pode re-emitir com idNotaFiscalTiny diferente mas mesma chave de acesso
  // (raro, mas acontece em re-emissões pós-cancelamento). Lookup composto
  // captura ambos os casos antes de inserir um log duplicado já processado.
  const idAsText = String(idNotaFiscalTiny);
  const dedupResults = await Promise.all([
    supabase
      .from("siso_webhook_logs")
      .select("id, processado_em")
      .eq("tipo", "nota_fiscal")
      .eq("tiny_pedido_id", idAsText)
      .not("processado_em", "is", null)
      .limit(1)
      .maybeSingle(),
    chaveAcesso
      ? supabase
          .from("siso_webhook_logs")
          .select("id, processado_em")
          .eq("tipo", "nota_fiscal")
          .filter("payload->dados->>chaveAcesso", "eq", chaveAcesso)
          .not("processado_em", "is", null)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const priorById = dedupResults[0].data;
  const priorByChave = dedupResults[1].data;
  if (priorById || priorByChave) {
    logger.info("nf-webhook", "NF já processada previamente — skip dedup composto", {
      idNotaFiscalTiny: idAsText,
      chaveAcesso: chaveAcesso ?? null,
      priorLogId: (priorById ?? priorByChave)?.id,
      matchedBy: priorById ? "nota_fiscal_id" : "chave_acesso_nf",
    });
    return;
  }

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

      // [Fix-D #6.12] Antes de ignorar como "não-venda", checa se é uma
      // devolução. Tiny v3 às vezes entrega NF de devolução com
      // origem.tipo='devolucao' (ou inconsistência onde precisa do hint
      // composto via isDevolucao). Roteia pra siso_devolucoes_pendentes
      // best-effort em vez de ignorar — o webhook receiver também roteia
      // (linhas 94-121 de webhook/tiny/route.ts) mas pode não pegar quando
      // o payload base não tinha o hint e só o /notas/{id} revela.
      if (isDevolucao(nf)) {
        logger.info("nf-webhook", "NF é devolução — roteando pra fila", {
          idNotaFiscalTiny: String(idNotaFiscalTiny),
          origemTipo: nf.origem?.tipo ?? "unknown",
          empresaId,
        });
        try {
          const { registrarDevolucaoPendente } = await import("@/lib/wms/devolucoes");
          await registrarDevolucaoPendente({
            nota_fiscal_id: idNotaFiscalTiny,
            chave_acesso_nf: nf.chaveAcesso ?? undefined,
            pedido_origem_id: nf.origem?.id ?? undefined,
            empresa_id: empresaId,
            payload_webhook: payload as unknown as Record<string, unknown>,
          });
        } catch (e) {
          logger.warn("nf-webhook", "falha ao enfileirar devolução no fallback", {
            idNotaFiscalTiny: String(idNotaFiscalTiny),
            e: e instanceof Error ? e.message : String(e),
          });
        }
        await supabase
          .from("siso_webhook_logs")
          .update({ status: "roteado_devolucao", processado_em: new Date().toISOString() })
          .eq("id", webhookLogId);
        return;
      }

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
      if (wmsAsSource()) {
        // Em modo WMS, o cutover só roda quando status entra no conjunto forward
        // (separado/embalado/expedido). O webhook da NF só transita pra
        // aguardando_separacao — o cutover dispara quando o operador concluir.
        // Mas se o operador concluiu ANTES da NF chegar (race), status já é
        // forward agora — o helper dispara no ato.
        const result = await dispararCutoverSePronto(pedidoId);
        logger.info("nf-webhook", "WMS mode: dispararCutoverSePronto chamado", {
          pedidoId,
          decisao: pedidoData.decisao_final,
          enqueued: result.enqueued,
          motivo: result.motivo,
        });
      } else {
        // Modo Tiny legado: enfileira pos_nf direto pra rodar via worker.
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
