import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getEmpresaByCnpj } from "@/lib/empresa-lookup";
import { processWebhook } from "@/lib/webhook-processor";
import { handleNfWebhook, isDevolucao, type NfWebhookPayload } from "@/lib/nf-webhook-handler";
import { handlePedidoCancelamento } from "@/lib/pedido-cancel-handler";
import { logger, generateCorrelationId } from "@/lib/logger";

/**
 * POST /api/webhook/tiny
 *
 * Receives webhooks from Tiny ERP when orders are updated.
 *
 * Flow:
 * 1. Validate payload (tipo, codigoSituacao)
 * 2. Identify empresa by CNPJ (via siso_empresas)
 * 3. Deduplicate by pedido_id + tipo + situacao
 * 4. Respond 200 immediately
 * 5. Process asynchronously (fetch order, enrich stock, save)
 */
export async function POST(request: NextRequest) {
  const correlationId = generateCorrelationId();
  let payload: Record<string, unknown>;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  logger.info("webhook", "Raw payload received", {
    correlationId,
    keys: Object.keys(payload),
    payload: JSON.stringify(payload).slice(0, 500),
  });

  const tipo = payload.tipo as string | undefined;
  const cnpj = payload.cnpj as string | undefined;
  const dados = payload.dados as Record<string, unknown> | undefined;

  if (!tipo || !cnpj || !dados) {
    logger.warn("webhook", "Missing required fields", { tipo, cnpj, hasDados: !!dados });
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Identify empresa by CNPJ (shared by all webhook types)
  const empresa = await getEmpresaByCnpj(cnpj);
  if (!empresa) {
    logger.warn("webhook", `Received webhook from unknown CNPJ`, { cnpj, tipo });
    return NextResponse.json(
      { error: `Unknown CNPJ: ${cnpj}` },
      { status: 400 },
    );
  }

  // ─── Discriminate by tipo BEFORE validating codigoSituacao ───────────────
  if (tipo === "nota_fiscal") {
    const nfPayload = payload as unknown as NfWebhookPayload;
    if (!nfPayload.dados?.idNotaFiscalTiny) {
      logger.warn("webhook", "NF webhook missing idNotaFiscalTiny", { cnpj });
      return NextResponse.json({ error: "Missing dados.idNotaFiscalTiny" }, { status: 400 });
    }

    handleNfWebhook(nfPayload, empresa.empresaId).catch((err) => {
      logger.logError({
        error: err,
        source: "webhook",
        message: "NF webhook processing failed",
        category: "external_api",
        pedidoId: String(nfPayload.dados.idNotaFiscalTiny),
        empresaId: empresa.empresaId,
        correlationId,
        requestPath: "/api/wms/webhook/tiny",
        requestMethod: "POST",
        metadata: { tipo: "nota_fiscal" },
      });
    });

    // WMS Plano 5: detecta NF de devolução e enfileira pra classificação
    // física pelo operador. Best-effort, não afeta o fluxo principal.
    // Tiny payload básico não carrega tipo_operacao — quando carrega, a
    // condição abaixo dispara. Caso contrário fica no-op (graceful).
    // PR-2 #6.12: centraliza detecção em isDevolucao pra cobrir todas as
    // variantes (tipo_nota/tipoOperacao/finalidade) consistentemente.
    const dadosNf = nfPayload.dados as Record<string, unknown>;
    const tipoOperacao = (dadosNf.tipoOperacao ?? dadosNf.tipo_operacao) as
      | string
      | undefined;
    const tipoNota = dadosNf.tipo_nota as string | undefined;
    const finalidade = (dadosNf.finalidade ?? dadosNf.finalidade_nf) as
      | string
      | undefined;
    if (
      isDevolucao({ tipo: tipoNota, tipoOperacao, finalidade })
    ) {
      void (async () => {
        try {
          const { registrarDevolucaoPendente } = await import(
            "@/lib/wms/devolucoes"
          );
          await registrarDevolucaoPendente({
            nota_fiscal_id: nfPayload.dados.idNotaFiscalTiny,
            chave_acesso_nf: nfPayload.dados.chaveAcesso ?? undefined,
            pedido_origem_id: (dadosNf.numero_pedido ?? dadosNf.numero) as
              | string
              | undefined,
            empresa_id: empresa.empresaId,
            payload_webhook: nfPayload,
          });
          logger.info("webhook.tiny", "WMS devolução enfileirada", {
            idNotaFiscalTiny: nfPayload.dados.idNotaFiscalTiny,
            empresaId: empresa.empresaId,
          });
        } catch (e) {
          logger.warn("webhook.tiny", "falha ao enfileirar devolução WMS", {
            e: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    }

    return NextResponse.json({ status: "queued", tipo: "nota_fiscal" });
  }

  // ─── Order webhooks (existing flow) ─────────────────────────────────────
  const codigoSituacao = (dados.codigoSituacao as string) ?? "";
  const tiposAceitos = ["atualizacao_pedido", "inclusao_pedido"];
  const situacoesAceitas = ["aprovado", "cancelado"];
  if (!tiposAceitos.includes(tipo) || !situacoesAceitas.includes(codigoSituacao)) {
    logger.info("webhook", "Ignoring event", { tipo, codigoSituacao, dadosKeys: Object.keys(dados) });
    return NextResponse.json({ status: "ignored", reason: "Not an approved/cancelled order event" });
  }

  const pedidoId = dados.id as string;
  if (!pedidoId) {
    return NextResponse.json({ error: "Missing dados.id" }, { status: 400 });
  }

  const filial = empresa.galpaoNome;

  logger.info("webhook", "Webhook received", {
    pedidoId,
    empresaId: empresa.empresaId,
    empresaNome: empresa.empresaNome,
    galpao: empresa.galpaoNome,
    codigoSituacao,
  });

  // Insert webhook log (dedup via unique index on dedup_key)
  const supabase = createServiceClient();
  const { data: logEntry, error: insertError } = await supabase
    .from("siso_webhook_logs")
    .insert({
      tiny_pedido_id: pedidoId,
      cnpj,
      tipo,
      codigo_situacao: codigoSituacao,
      filial,
      empresa_id: empresa.empresaId,
      payload,
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      logger.info("webhook", "Duplicate webhook ignored", { pedidoId, empresaId: empresa.empresaId, codigoSituacao });
      return NextResponse.json({ status: "duplicate", pedidoId });
    }
    logger.logError({
      error: insertError,
      source: "webhook",
      message: "Failed to insert webhook log",
      category: "database",
      pedidoId,
      empresaId: empresa.empresaId,
      correlationId,
      requestPath: "/api/wms/webhook/tiny",
      requestMethod: "POST",
      errorCode: insertError.code,
      metadata: { table: "siso_webhook_logs" },
    });
    return NextResponse.json(
      { error: "Failed to log webhook" },
      { status: 500 },
    );
  }

  const webhookLogId = logEntry.id;

  // Handle cancellation (lógica compartilhada com o polling fallback)
  if (codigoSituacao === "cancelado") {
    const result = await handlePedidoCancelamento({
      pedidoId,
      webhookLogId,
      empresaId: empresa.empresaId,
    });

    if (result.status === "cancelled") {
      return NextResponse.json({
        status: "cancelled",
        pedidoId,
        previousStatus: result.previousStatus,
      });
    }

    return NextResponse.json({ status: "cancelled_unknown", pedidoId });
  }

  // Process approved order
  processWebhook(
    webhookLogId,
    pedidoId,
    empresa.empresaId,
    empresa.galpaoId,
    empresa.grupoId,
  ).catch((err) => {
    logger.logError({
      error: err,
      source: "webhook",
      message: `Processing task failed for pedido ${pedidoId}`,
      category: "business_logic",
      pedidoId,
      empresaId: empresa.empresaId,
      empresaNome: empresa.empresaNome,
      galpaoNome: empresa.galpaoNome,
      correlationId,
      requestPath: "/api/wms/webhook/tiny",
      requestMethod: "POST",
      metadata: { webhookLogId },
    });
  });

  return NextResponse.json({
    status: "queued",
    pedidoId,
    empresaId: empresa.empresaId,
    galpao: empresa.galpaoNome,
    webhookLogId,
  });
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "SISO Webhook Receiver",
    accepts: "POST with Tiny ERP webhook payload",
  });
}
