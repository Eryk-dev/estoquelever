import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getFilialByCnpj } from "@/lib/cnpj-filial";
import { processWebhook } from "@/lib/webhook-processor";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhook/tiny
 *
 * Receives webhooks from Tiny ERP when orders are updated.
 * The Tiny webhook URL should be configured to point here.
 *
 * Flow:
 * 1. Validate payload (tipo, codigoSituacao)
 * 2. Identify branch by CNPJ
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

  // Extract fields from Tiny webhook
  const tipo = payload.tipo as string | undefined;
  const cnpj = payload.cnpj as string | undefined;
  const dados = payload.dados as Record<string, unknown> | undefined;

  if (!tipo || !cnpj || !dados) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Only process approved or cancelled order updates
  const codigoSituacao = (dados.codigoSituacao as string) ?? "";
  const situacoesAceitas = ["aprovado", "cancelado"];
  if (tipo !== "atualizacao_pedido" || !situacoesAceitas.includes(codigoSituacao)) {
    logger.info("webhook", "Ignoring non-order or non-approved/cancelled event", { tipo, codigoSituacao });
    return NextResponse.json({ status: "ignored", reason: "Not an approved/cancelled order update" });
  }

  const pedidoId = dados.id as string;
  if (!pedidoId) {
    return NextResponse.json({ error: "Missing dados.id" }, { status: 400 });
  }

  // Identify branch
  const filial = getFilialByCnpj(cnpj);
  if (!filial) {
    logger.warn("webhook", `Received webhook from unknown CNPJ`, { cnpj, tipo });
    return NextResponse.json(
      { error: `Unknown CNPJ: ${cnpj}` },
      { status: 400 },
    );
  }

  logger.info("webhook", "Webhook received", {
    pedidoId,
    filial,
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
      payload,
    })
    .select("id")
    .single();

  if (insertError) {
    // Duplicate — already processed
    if (insertError.code === "23505") {
      logger.info("webhook", "Duplicate webhook ignored", { pedidoId, filial, codigoSituacao });
      return NextResponse.json({ status: "duplicate", pedidoId });
    }
    console.error("Webhook log insert error:", insertError);
    logger.error("webhook", "Failed to insert webhook log", {
      pedidoId,
      filial,
      supabaseError: insertError.message,
    });
    return NextResponse.json(
      { error: "Failed to log webhook" },
      { status: 500 },
    );
  }

  const webhookLogId = logEntry.id;

  // Handle cancellation: mark existing order as cancelled
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

      // Cancel any pending execution jobs to prevent stock posting
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
        filial,
        previousStatus: existingOrder.status,
      });

      return NextResponse.json({
        status: "cancelled",
        pedidoId,
        previousStatus: existingOrder.status,
      });
    }

    // Order not in system yet — just log and ignore
    await supabase
      .from("siso_webhook_logs")
      .update({ status: "concluido", processado_em: new Date().toISOString() })
      .eq("id", webhookLogId);

    logger.info("webhook", "Cancellation received for unknown order", { pedidoId, filial });

    return NextResponse.json({ status: "cancelled_unknown", pedidoId });
  }

  // Process approved order (Easypanel = long-running, safe to await)
  processWebhook(webhookLogId, pedidoId, filial).catch((err) => {
    console.error(`Webhook processing failed for pedido ${pedidoId}:`, err);
    logger.error("webhook", `Processing task failed for pedido ${pedidoId}`, {
      pedidoId,
      filial,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({
    status: "queued",
    pedidoId,
    filial,
    webhookLogId,
  });
}

// Also handle GET for health check / webhook URL verification
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "SISO Webhook Receiver",
    accepts: "POST with Tiny ERP webhook payload",
  });
}
