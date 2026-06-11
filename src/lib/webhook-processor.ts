import { createServiceClient } from "./supabase-server";
import { getPedido } from "./tiny-api";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { getEmpresaById } from "./empresa-lookup";
import { criadoAntesDoDiaDoCorte } from "./sync-pedidos-corte";
import { logger, getCorrelationId } from "./logger";
import { processWebhookWms } from "./webhook-processor-wms";

/** Serialize any thrown value into a readable string */
function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Process an incoming Tiny webhook payload (pedido).
 *
 * Estoque é fonte única WMS: este handler resolve o galpão de origem, busca o
 * pedido no Tiny (camada fiscal/marketplace) e delega TODO o processamento de
 * estoque pra `processWebhookWms` — que lê saldo de `siso_estoque`, roteia via
 * algoritmo WMS-3 e cria as reservas no ledger.
 *
 * @param _grupoId mantido na assinatura por compat com os callers
 *   (webhook/tiny, webhook/reprocessar); o fluxo WMS não usa grupo pra
 *   enriquecer estoque (saldo é fungível por galpão).
 */
export async function processWebhook(
  webhookLogId: string,
  pedidoTinyId: string,
  empresaOrigemId: string,
  galpaoOrigemId: string,
  _grupoId: string | null,
) {
  const supabase = createServiceClient();

  await supabase
    .from("siso_webhook_logs")
    .update({ status: "processando" })
    .eq("id", webhookLogId);

  logger.info("processor", "Processing webhook", {
    pedidoId: pedidoTinyId,
    empresaId: empresaOrigemId,
    webhookLogId,
  });

  try {
    // 0. Resolve galpao name (passado pro processador WMS)
    let galpaoOrigemNome: string;
    {
      const { data: galpaoRow } = await supabase
        .from("siso_galpoes")
        .select("nome")
        .eq("id", galpaoOrigemId)
        .single();
      galpaoOrigemNome = galpaoRow?.nome ?? "CWB";
    }

    // 1. Token da empresa origem — usado só pra buscar o pedido no Tiny
    //    (camada fiscal/marketplace; estoque não vem mais do Tiny).
    const { token: origemToken } = await getValidTokenByEmpresa(empresaOrigemId);

    // 2. Fetch order details from Tiny (origin empresa)
    const pedido = await runWithEmpresa(empresaOrigemId, () =>
      getPedido(origemToken, pedidoTinyId),
    );

    // 2a. Skip non-marketplace orders (internal/manual Tiny orders should not enter SISO)
    if (!pedido.nomeEcommerce && !pedido.idPedidoEcommerce) {
      logger.info("processor", "Skipping non-marketplace order", {
        pedidoId: pedidoTinyId,
        numero: pedido.numero,
        clienteNome: pedido.cliente.nome,
      });

      await supabase
        .from("siso_webhook_logs")
        .update({
          status: "ignorado",
          processado_em: new Date().toISOString(),
          erro: "Pedido sem ecommerce — não é marketplace",
        })
        .eq("id", webhookLogId);

      return;
    }

    // 2b. Corte de migração (siso_empresas.sync_pedidos_desde): pedido criado
    // em dia anterior ao corte pertence ao processo antigo — não entra no WMS.
    // Pega webhook de atualização de pedido velho; semântica em
    // lib/sync-pedidos-corte.ts.
    const empresaInfo = await getEmpresaById(empresaOrigemId);
    const corte = empresaInfo?.syncPedidosDesde ?? null;
    if (corte && criadoAntesDoDiaDoCorte(pedido.data, corte)) {
      logger.info("processor", "Skipping pedido criado antes do corte de sync", {
        pedidoId: pedidoTinyId,
        numero: pedido.numero,
        dataPedido: pedido.data,
        corte,
        empresaId: empresaOrigemId,
      });

      await supabase
        .from("siso_webhook_logs")
        .update({
          status: "ignorado",
          processado_em: new Date().toISOString(),
          erro: `Pedido criado em ${pedido.data}, antes do corte de sincronização (${corte})`,
        })
        .eq("id", webhookLogId);

      return;
    }

    // 3. WMS é a fonte única de estoque — delega o processamento completo.
    return await processWebhookWms({
      webhookLogId,
      pedido,
      empresaOrigemId,
      galpaoOrigemId,
      galpaoOrigemNome,
    });
  } catch (err) {
    const msg = serializeError(err);
    await supabase
      .from("siso_webhook_logs")
      .update({ status: "erro", erro: msg, processado_em: new Date().toISOString() })
      .eq("id", webhookLogId);
    logger.logError({
      error: err,
      source: "processor",
      message: "Webhook processing failed",
      category: msg.includes("token") || msg.includes("Token")
        ? "auth"
        : msg.includes("rate") || msg.includes("429")
          ? "infrastructure"
          : "external_api",
      severity: "critical",
      pedidoId: pedidoTinyId,
      empresaId: empresaOrigemId,
      correlationId: getCorrelationId(),
      metadata: { webhookLogId },
    });
    throw err;
  }
}
