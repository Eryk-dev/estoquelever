import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getEmpresaByCnpj } from "@/lib/empresa-lookup";
import { processWebhook } from "@/lib/webhook-processor";
import { handleNfWebhook, type NfWebhookPayload } from "@/lib/nf-webhook-handler";
import { logger } from "@/lib/logger";

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
  let payload: Record<string, unknown>;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  logger.info("webhook", "Raw payload received", {
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
      logger.error("webhook", "NF webhook processing failed", {
        idNotaFiscalTiny: String(nfPayload.dados.idNotaFiscalTiny),
        empresaId: empresa.empresaId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

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

  // Legacy filial name for backwards compat
  const filial = empresa.galpaoNome as "CWB" | "SP";

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
    logger.error("webhook", "Failed to insert webhook log", {
      pedidoId,
      empresaId: empresa.empresaId,
      supabaseError: insertError.message,
    });
    return NextResponse.json(
      { error: "Failed to log webhook" },
      { status: 500 },
    );
  }

  const webhookLogId = logEntry.id;

  // Handle cancellation
  if (codigoSituacao === "cancelado") {
    const { data: existingOrder } = await supabase
      .from("siso_pedidos")
      .select("id, status")
      .eq("id", pedidoId)
      .single();

    if (existingOrder) {
      await supabase
        .from("siso_pedidos")
        .update({
          status: "cancelado",
          processado_em: new Date().toISOString(),
        })
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
        empresaId: empresa.empresaId,
        previousStatus: existingOrder.status,
      });

      return NextResponse.json({
        status: "cancelled",
        pedidoId,
        previousStatus: existingOrder.status,
      });
    }

    await supabase
      .from("siso_webhook_logs")
      .update({ status: "concluido", processado_em: new Date().toISOString() })
      .eq("id", webhookLogId);

    logger.info("webhook", "Cancellation received for unknown order", {
      pedidoId,
      empresaId: empresa.empresaId,
    });

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
    const msg = err instanceof Error ? err.message
      : (typeof err === "object" && err !== null && "message" in err)
        ? String((err as { message: unknown }).message)
        : JSON.stringify(err);
    logger.error("webhook", `Processing task failed for pedido ${pedidoId}`, {
      pedidoId,
      empresaId: empresa.empresaId,
      error: msg,
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
