/**
 * Etiqueta (shipping label) service.
 *
 * Fetches shipping labels from Tiny via expedição/agrupamento,
 * sends them to PrintNode for printing, and tracks etiqueta_status.
 *
 * Flow:
 *   1. Resolve label URL (cached or via Tiny API)
 *   2. Resolve printer (user override > galpão default)
 *   3. Send to PrintNode
 *   4. Update etiqueta_status
 */

import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { criarAgrupamento, obterEtiquetasAgrupamento } from "@/lib/tiny-api";
import { enviarImpressao, resolverImpressora } from "@/lib/printnode";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "etiqueta-service";

/**
 * Fetch, cache, and print the shipping label for a packed order.
 *
 * Idempotent: returns early if etiqueta_status is already 'impresso'.
 * On any error, sets etiqueta_status = 'falhou' and logs (never throws to caller).
 */
export async function buscarEImprimirEtiqueta(pedidoId: string): Promise<void> {
  const supabase = createServiceClient();

  // 1. Fetch pedido
  const { data: pedido, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select(
      "id, numero, empresa_origem_id, agrupamento_expedicao_id, etiqueta_url, etiqueta_status, separacao_galpao_id, separacao_operador_id"
    )
    .eq("id", pedidoId)
    .single();

  if (fetchErr || !pedido) {
    logger.error(LOG_SOURCE, "Pedido não encontrado", { pedidoId, error: fetchErr?.message });
    return;
  }

  // 2. Idempotent — skip if already printed
  if (pedido.etiqueta_status === "impresso") {
    logger.info(LOG_SOURCE, "Etiqueta já impressa, skip", { pedidoId });
    return;
  }

  if (!pedido.empresa_origem_id) {
    await setStatus(supabase, pedidoId, "falhou");
    logger.error(LOG_SOURCE, "Pedido sem empresa_origem_id", { pedidoId });
    return;
  }

  try {
    // 3. Resolve label URL
    const etiquetaUrl = await resolverEtiquetaUrl(supabase, pedido);

    if (!etiquetaUrl) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.error(LOG_SOURCE, "Não foi possível obter URL da etiqueta", { pedidoId });
      return;
    }

    // 4. Update status to 'imprimindo'
    await setStatus(supabase, pedidoId, "imprimindo");

    // 5. Resolve printer
    const printNodeApiKey = await getConfig("PRINTNODE_API_KEY");
    if (!printNodeApiKey) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.error(LOG_SOURCE, "PRINTNODE_API_KEY não configurada", { pedidoId });
      return;
    }

    const usuarioId = pedido.separacao_operador_id;
    const galpaoId = pedido.separacao_galpao_id;

    if (!galpaoId) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.error(LOG_SOURCE, "Pedido sem separacao_galpao_id", { pedidoId });
      return;
    }

    const printer = await resolverImpressora(usuarioId ?? galpaoId, galpaoId);
    if (!printer) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.warn(LOG_SOURCE, "Nenhuma impressora configurada", { pedidoId, galpaoId });
      return;
    }

    // 6. Send to PrintNode
    await enviarImpressao({
      apiKey: printNodeApiKey,
      printerId: printer.printerId,
      pdfUrl: etiquetaUrl,
      titulo: `Etiqueta Pedido #${pedido.numero ?? pedidoId}`,
    });

    // 7. Success
    await setStatus(supabase, pedidoId, "impresso");
    logger.info(LOG_SOURCE, "Etiqueta impressa com sucesso", {
      pedidoId,
      printerId: String(printer.printerId),
    });
  } catch (err) {
    await setStatus(supabase, pedidoId, "falhou");
    logger.error(LOG_SOURCE, "Falha ao imprimir etiqueta", {
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

interface PedidoRow {
  id: string;
  numero: string;
  empresa_origem_id: string;
  agrupamento_expedicao_id: string | null;
  etiqueta_url: string | null;
  separacao_galpao_id: string | null;
  separacao_operador_id: string | null;
}

type SupabaseClient = ReturnType<typeof createServiceClient>;

async function setStatus(
  supabase: SupabaseClient,
  pedidoId: string,
  status: "pendente" | "imprimindo" | "impresso" | "falhou",
): Promise<void> {
  await supabase
    .from("siso_pedidos")
    .update({ etiqueta_status: status })
    .eq("id", pedidoId);
}

/**
 * Resolve the label URL for a pedido:
 *   1. If etiqueta_url already cached → return it
 *   2. If agrupamento_expedicao_id exists → GET etiquetas
 *   3. Otherwise → POST to create agrupamento, then GET etiquetas
 *
 * Saves agrupamento_expedicao_id and etiqueta_url to DB for reuse.
 */
async function resolverEtiquetaUrl(
  supabase: SupabaseClient,
  pedido: PedidoRow,
): Promise<string | null> {
  // Already cached
  if (pedido.etiqueta_url) {
    return pedido.etiqueta_url;
  }

  const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);

  let agrupamentoId: number | null = pedido.agrupamento_expedicao_id ? parseInt(pedido.agrupamento_expedicao_id, 10) : null;

  // Create agrupamento if needed
  if (!agrupamentoId) {
    const pedidoNumerico = parseInt(pedido.id, 10);
    if (isNaN(pedidoNumerico)) {
      // id is UUID — need the Tiny numeric ID. Use numero field.
      const numero = parseInt(pedido.numero, 10);
      if (isNaN(numero)) {
        logger.error(LOG_SOURCE, "Pedido sem ID numérico para criar agrupamento", {
          pedidoId: pedido.id,
        });
        return null;
      }
      const res = await criarAgrupamento(token, [numero]);
      agrupamentoId = res.id;
    } else {
      const res = await criarAgrupamento(token, [pedidoNumerico]);
      agrupamentoId = res.id;
    }

    // Save agrupamento_expedicao_id
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: String(agrupamentoId) })
      .eq("id", pedido.id);
  }

  // Fetch label URLs
  const etiquetas = await obterEtiquetasAgrupamento(token, agrupamentoId);

  if (!etiquetas.urls || etiquetas.urls.length === 0) {
    logger.warn(LOG_SOURCE, "Nenhuma URL de etiqueta retornada", {
      pedidoId: pedido.id,
      agrupamentoId: String(agrupamentoId),
    });
    return null;
  }

  const url = etiquetas.urls[0];

  // Cache URL (never exposed to frontend — LGPD)
  await supabase
    .from("siso_pedidos")
    .update({ etiqueta_url: url })
    .eq("id", pedido.id);

  return url;
}
