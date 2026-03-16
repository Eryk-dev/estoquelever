/**
 * Agrupamento (expedition grouping) pre-creation service.
 *
 * Called fire-and-forget when separation concludes (pedidos → "separado").
 * Groups pedidos by empresa_origem_id + shipping method (forma_envio_id,
 * forma_frete_id, transportador_id), creates one Tiny agrupamento per group,
 * downloads ZPL labels, and caches everything in DB.
 *
 * Uses atomic claim (siso_claim_pedidos_para_agrupamento) to prevent duplicate
 * agrupamentos when called concurrently (e.g. double-click on "iniciar").
 *
 * At packing time, the ZPL is already cached — we just send it to PrintNode
 * without any Tiny API calls, cutting the bip-to-print delay to ~1s.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { criarAgrupamento, concluirAgrupamento, obterEtiquetasAgrupamento } from "@/lib/tiny-api";
import { baixarZpl } from "@/lib/etiqueta-download";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "agrupamento-service";

interface PedidoClaimed {
  id: string;
  numero: string;
  empresa_origem_id: string;
  nota_fiscal_id: number | null;
  forma_envio_id: string | null;
  forma_frete_id: string | null;
  transportador_id: string | null;
}

/**
 * Build a grouping key from empresa + shipping fields.
 * Pedidos with the same key can be in the same Tiny agrupamento.
 */
function buildGroupKey(p: PedidoClaimed): string {
  return `${p.empresa_origem_id}|${p.forma_envio_id ?? ""}|${p.forma_frete_id ?? ""}|${p.transportador_id ?? ""}`;
}

/**
 * Pre-create Tiny agrupamentos in batch for pedidos that just became "separado".
 * Uses atomic claim to prevent duplicate agrupamentos on concurrent calls.
 * Groups by empresa + shipping method, creates one agrupamento per group,
 * downloads ZPL labels, and caches them in etiqueta_zpl column.
 *
 * Errors are logged but never thrown — this is fire-and-forget.
 */
export async function preCriarAgrupamentosEmLote(
  pedidoIds: string[],
): Promise<void> {
  if (pedidoIds.length === 0) return;

  const supabase = createServiceClient();

  // Atomic claim: sets agrupamento_expedicao_id = 'pending' and returns claimed rows.
  // Concurrent callers will get an empty result for already-claimed pedidos.
  const { data: pedidos, error: claimErr } = await supabase.rpc(
    "siso_claim_pedidos_para_agrupamento",
    { p_pedido_ids: pedidoIds },
  );

  if (claimErr) {
    logger.error(LOG_SOURCE, "Falha ao reivindicar pedidos para agrupamento", {
      pedidoIds,
      error: claimErr.message,
    });
    return;
  }

  if (!pedidos || pedidos.length === 0) {
    logger.info(LOG_SOURCE, "Nenhum pedido precisa de agrupamento (já reivindicados ou sem empresa)", {
      pedidoIds,
    });
    return;
  }

  // Group by empresa + shipping method
  const groups = new Map<string, PedidoClaimed[]>();
  for (const p of pedidos as PedidoClaimed[]) {
    const key = buildGroupKey(p);
    const lista = groups.get(key) ?? [];
    lista.push(p);
    groups.set(key, lista);
  }

  // Process each group in parallel
  const promises = Array.from(groups.entries()).map(
    ([key, pedidosGrupo]) => {
      const empresaId = pedidosGrupo[0].empresa_origem_id;
      return processarGrupo(supabase, empresaId, key, pedidosGrupo);
    },
  );

  await Promise.allSettled(promises);
}

// ─── Internal ────────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createServiceClient>;

async function processarGrupo(
  supabase: SupabaseClient,
  empresaId: string,
  groupKey: string,
  pedidos: PedidoClaimed[],
): Promise<void> {
  const pedidoIds = pedidos.map((p) => p.id);

  try {
    const { token } = await getValidTokenByEmpresa(empresaId);

    // Build NF IDs (Tiny requires idsNotasFiscais, not idsPedidos)
    const nfIds: number[] = [];
    const pedidoIdsPorNfId = new Map<number, string>();

    for (const p of pedidos) {
      if (!p.nota_fiscal_id) {
        logger.warn(LOG_SOURCE, "Pedido sem nota_fiscal_id, skip", { pedidoId: p.id });
        continue;
      }
      nfIds.push(p.nota_fiscal_id);
      pedidoIdsPorNfId.set(p.nota_fiscal_id, p.id);
    }

    if (nfIds.length === 0) return;

    // 1. Create single agrupamento using NF IDs
    const agrupamento = await criarAgrupamento(token, nfIds);
    const agrupamentoId = agrupamento.id;

    logger.info(LOG_SOURCE, "Agrupamento criado em lote", {
      empresaId,
      agrupamentoId: String(agrupamentoId),
      qtdNFs: String(nfIds.length),
      groupKey,
    });

    // Save real agrupamento_expedicao_id (replacing 'pending')
    const allPedidoIds = Array.from(pedidoIdsPorNfId.values());
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: String(agrupamentoId) })
      .in("id", allPedidoIds);

    // 2. Complete the agrupamento (required before labels are available)
    //    Non-fatal: Mercado Envios orders auto-request pickup, so concluir
    //    may return 400. We still attempt to fetch labels regardless.
    try {
      await concluirAgrupamento(token, agrupamentoId);
      logger.info(LOG_SOURCE, "Agrupamento concluído", {
        empresaId,
        agrupamentoId: String(agrupamentoId),
      });
    } catch (err) {
      logger.warn(LOG_SOURCE, "Não foi possível concluir agrupamento (tentando etiquetas mesmo assim)", {
        empresaId,
        agrupamentoId: String(agrupamentoId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Fetch etiqueta URLs
    const etiquetas = await obterEtiquetasAgrupamento(token, agrupamentoId);

    if (!etiquetas.urls || etiquetas.urls.length === 0) {
      logger.warn(LOG_SOURCE, "Nenhuma URL de etiqueta retornada", {
        agrupamentoId: String(agrupamentoId),
      });
      return;
    }

    // 4. Download ZPL content from each URL in parallel
    const downloads = await Promise.allSettled(
      etiquetas.urls.map((url) => baixarZpl(url)),
    );

    const zplContents = downloads.map((r) =>
      r.status === "fulfilled" ? r.value : null,
    );

    // 5. Map URLs/ZPL to pedidos and save
    if (allPedidoIds.length === 1) {
      await salvarEtiqueta(supabase, allPedidoIds[0], etiquetas.urls[0], zplContents[0]);
    } else if (etiquetas.urls.length === allPedidoIds.length) {
      const updates = allPedidoIds.map((pedidoId, i) =>
        salvarEtiqueta(supabase, pedidoId, etiquetas.urls[i], zplContents[i]),
      );
      await Promise.all(updates);
    } else {
      logger.warn(LOG_SOURCE, "URL count != pedido count, storing first for all", {
        urlCount: String(etiquetas.urls.length),
        pedidoCount: String(allPedidoIds.length),
      });
      const updates = allPedidoIds.map((pedidoId) =>
        salvarEtiqueta(supabase, pedidoId, etiquetas.urls[0], zplContents[0]),
      );
      await Promise.all(updates);
    }

    logger.info(LOG_SOURCE, "Etiquetas ZPL pré-cacheadas", {
      empresaId,
      agrupamentoId: String(agrupamentoId),
      total: String(etiquetas.urls.length),
      cached: String(zplContents.filter(Boolean).length),
    });
  } catch (err) {
    // On failure, clear 'pending' so it can be retried
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: null })
      .in("id", pedidoIds)
      .eq("agrupamento_expedicao_id", "pending");

    logger.error(LOG_SOURCE, "Falha ao pré-criar agrupamento", {
      empresaId,
      groupKey,
      pedidoIds,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function salvarEtiqueta(
  supabase: SupabaseClient,
  pedidoId: string,
  url: string,
  zpl: string | null,
): Promise<void> {
  await supabase
    .from("siso_pedidos")
    .update({
      etiqueta_url: url,
      etiqueta_zpl: zpl,
    })
    .eq("id", pedidoId);
}
