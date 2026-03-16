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
import { criarAgrupamento, concluirAgrupamento, obterEtiquetasAgrupamento } from "@/lib/tiny-api";
import { baixarZpl } from "@/lib/etiqueta-download";
import { enviarImpressaoZpl } from "@/lib/printnode";
import { resolverImpressora } from "@/lib/printnode";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";

const LOG_SOURCE = "etiqueta-service";

/**
 * Print the shipping label for a packed order.
 *
 * Idempotent: uses atomic UPDATE+WHERE to claim the print job.
 * Only one concurrent caller can succeed — others skip silently.
 * On any error, sets etiqueta_status = 'falhou' (never throws to caller).
 */
export async function buscarEImprimirEtiqueta(pedidoId: string): Promise<void> {
  const supabase = createServiceClient();

  // Atomic claim via RPC (bypasses PostgREST schema cache issue with etiqueta_status).
  // Only one concurrent caller can succeed — others get null back.
  const { data: claimed, error: claimErr } = await supabase.rpc("siso_claim_etiqueta", {
    p_pedido_id: pedidoId,
  });

  if (claimErr) {
    logger.error(LOG_SOURCE, "Falha ao reivindicar impressão", { pedidoId, error: claimErr.message });
    return;
  }

  if (!claimed) {
    logger.info(LOG_SOURCE, "Etiqueta já em andamento ou impressa, skip", { pedidoId });
    return;
  }

  const pedido = claimed as PedidoRow;

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
    registrarEvento({
      pedidoId,
      evento: "etiqueta_impressa",
      detalhes: { printerId: printer.printerId, cached: !!pedido.etiqueta_zpl },
    }).catch(() => {});
    logger.info(LOG_SOURCE, "Etiqueta ZPL impressa", {
      pedidoId,
      printerId: String(printer.printerId),
      cached: String(!!pedido.etiqueta_zpl),
    });
  } catch (err) {
    await setStatus(supabase, pedidoId, "falhou");
    registrarEvento({
      pedidoId,
      evento: "etiqueta_falhou",
      detalhes: { error: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
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
  nota_fiscal_id: number | null;
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
  // Use RPC to bypass PostgREST schema cache issue with etiqueta_status
  await supabase.rpc("siso_set_etiqueta_status", {
    p_pedido_id: pedidoId,
    p_status: status,
  });
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
    const pedidoTinyId = parseInt(pedido.id, 10);
    if (isNaN(pedidoTinyId)) {
      logger.error(LOG_SOURCE, "Pedido com id não numérico", { pedidoId: pedido.id });
      return null;
    }
    const res = await criarAgrupamento(token, [pedidoTinyId]);
    agrupamentoId = res.id;

    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: String(agrupamentoId) })
      .eq("id", pedido.id);
  }

  // Conclude agrupamento (non-fatal: Mercado Envios may auto-request pickup)
  try {
    await concluirAgrupamento(token, agrupamentoId);
  } catch {
    logger.warn(LOG_SOURCE, "Não foi possível concluir agrupamento (tentando etiquetas mesmo assim)", {
      pedidoId: pedido.id,
      agrupamentoId: String(agrupamentoId),
    });
  }

  // Fetch URL — retry with delay because Tiny may take a moment to process conclusion
  let url = pedido.etiqueta_url;
  if (!url) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const etiquetas = await obterEtiquetasAgrupamento(token, agrupamentoId);
        if (etiquetas.urls && etiquetas.urls.length > 0) {
          url = etiquetas.urls[0];
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries && msg.includes("não foi concluído")) {
          logger.info(LOG_SOURCE, `Etiqueta não pronta, aguardando tentativa ${attempt + 1}/${maxRetries}`, {
            pedidoId: pedido.id,
            agrupamentoId: String(agrupamentoId),
          });
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw err;
      }
    }
    if (!url) return null;
  }

  // Download and extract ZPL from ZIP
  const zpl = await baixarZpl(url);
  if (!zpl) return null;

  // Cache for future use
  await supabase
    .from("siso_pedidos")
    .update({ etiqueta_url: url, etiqueta_zpl: zpl })
    .eq("id", pedido.id);

  return zpl;
}

