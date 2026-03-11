/**
 * Etiqueta (shipping label) service.
 *
 * Prints a ZPL label for a packed order. Two paths:
 *
 * FAST PATH (normal): ZPL was pre-cached by agrupamento-service at separation time.
 *   → Just send cached ZPL to PrintNode (~200ms)
 *
 * SLOW PATH (fallback): ZPL not cached (e.g. manual override, race condition).
 *   → Create agrupamento in Tiny → fetch URL → download ZPL → send to PrintNode (~3-5s)
 */

import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { criarAgrupamento, obterEtiquetasAgrupamento } from "@/lib/tiny-api";
import { enviarImpressaoZpl } from "@/lib/printnode";
import { resolverImpressora } from "@/lib/printnode";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "etiqueta-service";

/**
 * Print the shipping label for a packed order.
 *
 * Idempotent: returns early if etiqueta_status is already 'impresso'.
 * On any error, sets etiqueta_status = 'falhou' (never throws to caller).
 */
export async function buscarEImprimirEtiqueta(pedidoId: string): Promise<void> {
  const supabase = createServiceClient();

  const { data: pedido, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select(
      "id, numero, empresa_origem_id, agrupamento_expedicao_id, etiqueta_url, etiqueta_zpl, etiqueta_status, separacao_galpao_id, separacao_operador_id"
    )
    .eq("id", pedidoId)
    .single();

  if (fetchErr || !pedido) {
    logger.error(LOG_SOURCE, "Pedido não encontrado", { pedidoId, error: fetchErr?.message });
    return;
  }

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
    // Resolve ZPL content (fast path: cached, slow path: fetch from Tiny)
    const zpl = pedido.etiqueta_zpl ?? (await resolverZplFallback(supabase, pedido));

    if (!zpl) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.error(LOG_SOURCE, "Não foi possível obter ZPL", { pedidoId });
      return;
    }

    await setStatus(supabase, pedidoId, "imprimindo");

    // Resolve printer
    const printNodeApiKey = await getConfig("PRINTNODE_API_KEY");
    if (!printNodeApiKey) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.error(LOG_SOURCE, "PRINTNODE_API_KEY não configurada", { pedidoId });
      return;
    }

    const galpaoId = pedido.separacao_galpao_id;
    if (!galpaoId) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.error(LOG_SOURCE, "Pedido sem separacao_galpao_id", { pedidoId });
      return;
    }

    const printer = await resolverImpressora(pedido.separacao_operador_id ?? galpaoId, galpaoId);
    if (!printer) {
      await setStatus(supabase, pedidoId, "falhou");
      logger.warn(LOG_SOURCE, "Nenhuma impressora configurada", { pedidoId, galpaoId });
      return;
    }

    // Send ZPL directly to PrintNode
    await enviarImpressaoZpl({
      apiKey: printNodeApiKey,
      printerId: printer.printerId,
      zpl,
      titulo: `Etiqueta Pedido #${pedido.numero ?? pedidoId}`,
    });

    await setStatus(supabase, pedidoId, "impresso");
    logger.info(LOG_SOURCE, "Etiqueta ZPL impressa", {
      pedidoId,
      printerId: String(printer.printerId),
      cached: String(!!pedido.etiqueta_zpl),
    });
  } catch (err) {
    await setStatus(supabase, pedidoId, "falhou");
    logger.error(LOG_SOURCE, "Falha ao imprimir etiqueta", {
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

interface PedidoRow {
  id: string;
  numero: string;
  empresa_origem_id: string;
  agrupamento_expedicao_id: string | null;
  etiqueta_url: string | null;
  etiqueta_zpl: string | null;
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
 * Slow fallback: ZPL not pre-cached. Create agrupamento if needed,
 * fetch etiqueta URL, download ZPL, and cache for future use.
 */
async function resolverZplFallback(
  supabase: SupabaseClient,
  pedido: PedidoRow,
): Promise<string | null> {
  logger.warn(LOG_SOURCE, "ZPL não cacheado, fallback via Tiny API", {
    pedidoId: pedido.id,
  });

  const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);

  // Resolve or create agrupamento
  let agrupamentoId = pedido.agrupamento_expedicao_id
    ? parseInt(pedido.agrupamento_expedicao_id, 10)
    : null;

  if (!agrupamentoId) {
    const numero = parseInt(pedido.numero, 10);
    if (isNaN(numero)) {
      logger.error(LOG_SOURCE, "Pedido sem numero numérico", { pedidoId: pedido.id });
      return null;
    }
    const res = await criarAgrupamento(token, [numero]);
    agrupamentoId = res.id;

    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: String(agrupamentoId) })
      .eq("id", pedido.id);
  }

  // Fetch URL
  let url = pedido.etiqueta_url;
  if (!url) {
    const etiquetas = await obterEtiquetasAgrupamento(token, agrupamentoId);
    if (!etiquetas.urls || etiquetas.urls.length === 0) return null;
    url = etiquetas.urls[0];
  }

  // Download ZPL
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const zpl = await res.text();

  // Cache for future use
  await supabase
    .from("siso_pedidos")
    .update({ etiqueta_url: url, etiqueta_zpl: zpl })
    .eq("id", pedido.id);

  return zpl;
}
