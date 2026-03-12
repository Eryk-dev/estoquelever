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
      .select("id, status, status_separacao")
      .eq("id", pedidoId)
      .single();

    if (existingOrder) {
      const cancelUpdate: Record<string, unknown> = {
        status: "cancelado",
        status_unificado: "cancelado",
        processado_em: new Date().toISOString(),
      };
      if (existingOrder.status_separacao != null) {
        cancelUpdate.status_separacao = "cancelado";
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
        empresaId: empresa.empresaId,
        previousStatus: existingOrder.status,
        hadComprasCleanup: isInComprasFlow,
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

  // Process approved order (fire-and-forget)
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
