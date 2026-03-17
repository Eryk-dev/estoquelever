/**
 * Agrupamento (expedition grouping) pre-creation service.
 *
 * Called fire-and-forget when separation concludes (pedidos → "separado").
 * Groups pedidos by empresa_origem_id + shipping method (forma_envio_id,
 * forma_frete_id, transportador_id), creates one Tiny agrupamento per group,
 * downloads ZPL labels per expedition, and caches everything in DB.
 *
 * Uses atomic claim (siso_claim_pedidos_para_agrupamento) to prevent duplicate
 * agrupamentos when called concurrently (e.g. double-click on "iniciar").
 *
 * At packing time, the ZPL is already cached — we just send it to PrintNode
 * without any Tiny API calls, cutting the bip-to-print delay to ~1s.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import {
  criarAgrupamento,
  concluirAgrupamento,
  obterAgrupamento,
  obterEtiquetasExpedicao,
} from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";
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

  // Recover any pedidos stuck with 'pending' for >5 minutes (crash recovery)
  await recuperarPendingTravados(supabase, pedidoIds);

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

/**
 * Retry ZPL download for pedidos that have an agrupamento but no cached ZPL.
 * Called at separation conclusion (concluir) to fill any gaps left by the
 * initial pre-creation at iniciar time.
 *
 * Errors are logged but never thrown — fire-and-forget.
 */
export async function recarregarEtiquetasFaltantes(
  pedidoIds: string[],
): Promise<void> {
  if (pedidoIds.length === 0) return;

  const supabase = createServiceClient();

  // Find pedidos that have agrupamento but no ZPL cached
  const { data: pedidos, error } = await supabase
    .from("siso_pedidos")
    .select("id, empresa_origem_id, agrupamento_expedicao_id, etiqueta_url, etiqueta_zpl")
    .in("id", pedidoIds)
    .not("agrupamento_expedicao_id", "is", null)
    .neq("agrupamento_expedicao_id", "pending")
    .is("etiqueta_zpl", null);

  if (error || !pedidos || pedidos.length === 0) return;

  logger.info(LOG_SOURCE, "Recarregando etiquetas faltantes", {
    count: String(pedidos.length),
    pedidoIds: pedidos.map((p) => p.id),
  });

  // Group by empresa + agrupamento to minimize API calls
  const byEmpresa = new Map<string, typeof pedidos>();
  for (const p of pedidos) {
    const list = byEmpresa.get(p.empresa_origem_id) ?? [];
    list.push(p);
    byEmpresa.set(p.empresa_origem_id, list);
  }

  const promises = Array.from(byEmpresa.entries()).map(
    async ([empresaId, pedidosEmpresa]) => {
      try {
        const { token } = await getValidTokenByEmpresa(empresaId);

        await runWithEmpresa(empresaId, async () => {
          for (const pedido of pedidosEmpresa) {
            try {
              await recarregarZplPedido(supabase, token, pedido);
            } catch (err) {
              logger.warn(LOG_SOURCE, "Falha ao recarregar ZPL para pedido", {
                pedidoId: pedido.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        });
      } catch (err) {
        logger.warn(LOG_SOURCE, "Falha ao obter token para recarregar etiquetas", {
          empresaId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

    // All Tiny API calls within this scope are rate-limited for this empresa
    return await runWithEmpresa(empresaId, async () => {

    // Build Tiny pedido IDs (Tiny auto-includes the pedido's NF in the expedition)
    const idsTiny: number[] = [];
    const pedidoPorTinyId = new Map<number, string>();

    for (const p of pedidos) {
      const tinyId = parseInt(p.id, 10);
      if (isNaN(tinyId)) {
        logger.warn(LOG_SOURCE, "Pedido com id não numérico, skip", { pedidoId: p.id });
        continue;
      }
      idsTiny.push(tinyId);
      pedidoPorTinyId.set(tinyId, p.id);
    }

    if (idsTiny.length === 0) return;

    // 1. Create single agrupamento for all pedidos in this shipping group
    const agrupamento = await criarAgrupamento(token, idsTiny);
    const agrupamentoId = agrupamento.id;

    logger.info(LOG_SOURCE, "Agrupamento criado em lote", {
      empresaId,
      agrupamentoId: String(agrupamentoId),
      qtdPedidos: String(idsTiny.length),
      groupKey,
    });

    // Save real agrupamento_expedicao_id (replacing 'pending')
    const allPedidoIds = Array.from(pedidoPorTinyId.values());
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

    // 3. Get agrupamento details to discover expedition IDs per pedido
    const agrupamentoDetails = await obterAgrupamento(token, agrupamentoId);

    if (!agrupamentoDetails.expedicoes || agrupamentoDetails.expedicoes.length === 0) {
      logger.warn(LOG_SOURCE, "Agrupamento sem expedições", {
        agrupamentoId: String(agrupamentoId),
      });
      return;
    }

    // 4. Fetch labels per expedition (one per pedido) in parallel
    //    idObjeto is the pedido ID when tipoObjeto=pedido, or the NF ID when
    //    tipoObjeto=nota_fiscal. Use venda.id as fallback to always find the pedido.
    const labelPromises = agrupamentoDetails.expedicoes.map(async (exp) => {
      const pedidoId = pedidoPorTinyId.get(exp.idObjeto)
        ?? (exp.venda?.id ? pedidoPorTinyId.get(exp.venda.id) : undefined);
      if (!pedidoId) {
        logger.warn(LOG_SOURCE, "Expedição sem pedido correspondente", {
          agrupamentoId: String(agrupamentoId),
          expedicaoId: String(exp.id),
          idObjeto: String(exp.idObjeto),
          tipoObjeto: exp.tipoObjeto,
          vendaId: String(exp.venda?.id ?? ""),
        });
        return;
      }

      try {
        const etiquetas = await obterEtiquetasExpedicao(token, agrupamentoId, exp.id);

        if (!etiquetas.urls || etiquetas.urls.length === 0) {
          logger.warn(LOG_SOURCE, "Sem URL de etiqueta para expedição", {
            agrupamentoId: String(agrupamentoId),
            expedicaoId: String(exp.id),
            pedidoId,
          });
          return;
        }

        const url = etiquetas.urls[0];
        const zpl = await baixarZpl(url);

        await salvarEtiqueta(supabase, pedidoId, url, zpl);

        logger.info(LOG_SOURCE, "Etiqueta ZPL pré-cacheada", {
          pedidoId,
          expedicaoId: String(exp.id),
          cached: String(!!zpl),
        });
      } catch (err) {
        logger.warn(LOG_SOURCE, "Falha ao buscar etiqueta da expedição", {
          agrupamentoId: String(agrupamentoId),
          expedicaoId: String(exp.id),
          pedidoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    await Promise.allSettled(labelPromises);

    logger.info(LOG_SOURCE, "Etiquetas processadas", {
      empresaId,
      agrupamentoId: String(agrupamentoId),
      totalExpedicoes: String(agrupamentoDetails.expedicoes.length),
    });
    }); // end runWithEmpresa
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
  // Only cache ZPL if download was successful. Saving null ZPL with a URL
  // leaves the pedido in a state where fast path always fails and the URL
  // may be stale. Better to leave both null so fallback creates fresh.
  const updateData: Record<string, string | null> = { etiqueta_url: url };
  if (zpl) {
    updateData.etiqueta_zpl = zpl;
  }
  await supabase
    .from("siso_pedidos")
    .update(updateData)
    .eq("id", pedidoId);
}

/**
 * Recover pedidos stuck with agrupamento_expedicao_id = 'pending' for >5 minutes.
 * This can happen if the process crashes after the atomic claim but before
 * saving the real Tiny agrupamento ID.
 */
async function recuperarPendingTravados(
  supabase: SupabaseClient,
  pedidoIds: string[],
): Promise<void> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("siso_pedidos")
    .update({ agrupamento_expedicao_id: null })
    .in("id", pedidoIds)
    .eq("agrupamento_expedicao_id", "pending")
    .lt("updated_at", fiveMinAgo)
    .select("id");

  if (!error && data && data.length > 0) {
    logger.warn(LOG_SOURCE, "Recuperados pedidos com agrupamento travado em 'pending'", {
      pedidoIds: data.map((p) => p.id),
    });
  }
}

/**
 * Re-download ZPL for a single pedido that has an agrupamento but no cached ZPL.
 */
async function recarregarZplPedido(
  supabase: SupabaseClient,
  token: string,
  pedido: { id: string; agrupamento_expedicao_id: string | null; etiqueta_url: string | null },
): Promise<void> {
  const agrupamentoId = pedido.agrupamento_expedicao_id
    ? parseInt(pedido.agrupamento_expedicao_id, 10)
    : null;
  if (!agrupamentoId) return;

  const pedidoTinyId = parseInt(pedido.id, 10);
  if (isNaN(pedidoTinyId)) return;

  // If we already have a URL, just re-download the ZPL
  if (pedido.etiqueta_url) {
    const zpl = await baixarZpl(pedido.etiqueta_url);
    if (zpl) {
      await supabase
        .from("siso_pedidos")
        .update({ etiqueta_zpl: zpl })
        .eq("id", pedido.id);
      logger.info(LOG_SOURCE, "ZPL recarregado de URL existente", { pedidoId: pedido.id });
      return;
    }
  }

  // No URL or download failed — fetch fresh from Tiny
  const details = await obterAgrupamento(token, agrupamentoId);
  const exp = details.expedicoes?.find(
    (e) => e.idObjeto === pedidoTinyId || e.venda?.id === pedidoTinyId,
  );
  if (!exp) return;

  const etiquetas = await obterEtiquetasExpedicao(token, agrupamentoId, exp.id);
  if (!etiquetas.urls || etiquetas.urls.length === 0) return;

  const url = etiquetas.urls[0];
  const zpl = await baixarZpl(url);
  if (zpl) {
    await salvarEtiqueta(supabase, pedido.id, url, zpl);
    logger.info(LOG_SOURCE, "ZPL recarregado via Tiny API", { pedidoId: pedido.id });
  }
}
