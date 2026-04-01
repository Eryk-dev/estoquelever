/**
 * Agrupamento (expedition grouping) pre-creation service.
 *
 * Called fire-and-forget when separation concludes (pedidos → "separado").
 * Creates one Tiny agrupamento per pedido (1:1) to isolate failures —
 * if one pedido has a problem, it does not affect the others.
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
 * Pre-create Tiny agrupamentos for pedidos that just became "separado".
 * Creates one agrupamento per pedido (1:1) to isolate failures.
 * Uses atomic claim to prevent duplicate agrupamentos on concurrent calls.
 *
 * Errors are logged but never thrown — this is fire-and-forget.
 */
export async function preCriarAgrupamentosEmLote(
  pedidoIds: string[],
): Promise<void> {
  if (pedidoIds.length === 0) return;

  const supabase = createServiceClient();

  // Gate: only attempt agrupamento for pedidos with NF persistence complete
  // (both nota_fiscal_id and chave_acesso_nf must be set).
  const { data: nfReady } = await supabase
    .from("siso_pedidos")
    .select("id")
    .in("id", pedidoIds)
    .not("nota_fiscal_id", "is", null)
    .not("chave_acesso_nf", "is", null);

  const readyIds = (nfReady ?? []).map((p) => p.id);
  if (readyIds.length === 0) {
    logger.info(LOG_SOURCE, "Nenhum pedido com NF completa para agrupamento", { pedidoIds });
    return;
  }

  // Recover any pedidos stuck with 'pending' for >5 minutes (crash recovery)
  await recuperarPendingTravados(supabase, readyIds);

  // Atomic claim: sets agrupamento_expedicao_id = 'pending' and returns claimed rows.
  // Concurrent callers will get an empty result for already-claimed pedidos.
  const { data: pedidos, error: claimErr } = await supabase.rpc(
    "siso_claim_pedidos_para_agrupamento",
    { p_pedido_ids: readyIds },
  );

  if (claimErr) {
    logger.error(LOG_SOURCE, "Falha ao reivindicar pedidos para agrupamento", {
      pedidoIds: readyIds,
      error: claimErr.message,
    });
    return;
  }

  if (!pedidos || pedidos.length === 0) {
    logger.info(LOG_SOURCE, "Nenhum pedido precisa de agrupamento (já reivindicados ou sem empresa)", {
      pedidoIds: readyIds,
    });
    return;
  }

  // Group by empresa for token reuse + rate limiting
  const byEmpresa = new Map<string, PedidoClaimed[]>();
  for (const p of pedidos as PedidoClaimed[]) {
    const list = byEmpresa.get(p.empresa_origem_id) ?? [];
    list.push(p);
    byEmpresa.set(p.empresa_origem_id, list);
  }

  // Process each empresa's pedidos (each pedido gets its own agrupamento)
  const promises = Array.from(byEmpresa.entries()).map(
    ([empresaId, pedidosEmpresa]) =>
      processarPedidosEmpresa(supabase, empresaId, pedidosEmpresa),
  );

  await Promise.allSettled(promises);
}

/**
 * Smart retry for agrupamentos that exist but have missing ZPL labels.
 * Called at separation conclusion (concluir) and handles each state:
 *
 * 1. Agrupamento not found in Tiny (404) → clears agrupamento_id so it
 *    gets re-created on next iniciar/concluir via preCriarAgrupamentosEmLote.
 * 2. Agrupamento exists but not concluded → concludes it, then fetches labels.
 * 3. Agrupamento exists and concluded → fetches labels per expedition.
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
    .select("id, empresa_origem_id, agrupamento_expedicao_id, expedicao_id, etiqueta_url, etiqueta_zpl")
    .in("id", pedidoIds)
    .not("agrupamento_expedicao_id", "is", null)
    .neq("agrupamento_expedicao_id", "pending")
    .is("etiqueta_zpl", null);

  if (error || !pedidos || pedidos.length === 0) return;

  const pedidosValidos = pedidos.filter((p) =>
    /^\d+$/.test(p.agrupamento_expedicao_id ?? ""),
  );
  const skippedPedidos = pedidos.filter(
    (p) => !/^\d+$/.test(p.agrupamento_expedicao_id ?? ""),
  );

  if (skippedPedidos.length > 0) {
    logger.warn(LOG_SOURCE, "Ignorando pedidos com agrupamento não numérico no retry de etiqueta", {
      pedidoIds: skippedPedidos.map((p) => p.id),
      agrupamentos: skippedPedidos.map((p) => p.agrupamento_expedicao_id ?? "null"),
    });
  }

  if (pedidosValidos.length === 0) return;

  logger.info(LOG_SOURCE, "Recarregando etiquetas faltantes", {
    count: String(pedidosValidos.length),
    pedidoIds: pedidosValidos.map((p) => p.id),
  });

  // Group by empresa for token resolution
  const byEmpresa = new Map<string, typeof pedidosValidos>();
  for (const p of pedidosValidos) {
    const list = byEmpresa.get(p.empresa_origem_id) ?? [];
    list.push(p);
    byEmpresa.set(p.empresa_origem_id, list);
  }

  const promises = Array.from(byEmpresa.entries()).map(
    async ([empresaId, pedidosEmpresa]) => {
      try {
        const { token } = await getValidTokenByEmpresa(empresaId);

        await runWithEmpresa(empresaId, async () => {
          for (const p of pedidosEmpresa) {
            try {
              await retryAgrupamento(
                supabase,
                token,
                parseInt(p.agrupamento_expedicao_id!, 10),
                p,
              );
            } catch (err) {
              logger.warn(LOG_SOURCE, "Falha ao processar agrupamento no retry", {
                agrupamentoId: p.agrupamento_expedicao_id,
                empresaId,
                pedidoId: p.id,
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

/**
 * Fase-1 agrupamento: create agrupamento + discover expedicao_id as soon as
 * NF persistence is complete. Does NOT fetch etiqueta/ZPL — that is handled
 * by the fase-2 fast path (recarregarEtiquetasFaltantes).
 *
 * Called fire-and-forget from multiple entrypoints:
 * - Worker (propria, transferencia, oc) after enriquecerDadosNf
 * - NF webhook handler after chave_acesso_nf persistence
 * - webhook-processor NF reconciliation
 * - forcar-pendente routes after manual NF override
 *
 * Safe under concurrency: reuses the same atomic claim RPC
 * (siso_claim_pedidos_para_agrupamento) used by preCriarAgrupamentosEmLote.
 * Errors are logged but never thrown.
 */
export async function criarAgrupamentoFase1(pedidoId: string): Promise<void> {
  const supabase = createServiceClient();

  // 1. Re-fetch pedido to verify NF persistence gate
  const { data: pedido, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select("id, numero, empresa_origem_id, nota_fiscal_id, chave_acesso_nf, agrupamento_expedicao_id, forma_envio_id, forma_frete_id, transportador_id")
    .eq("id", pedidoId)
    .single();

  if (fetchErr || !pedido) {
    logger.warn(LOG_SOURCE, "Fase1: pedido não encontrado", { pedidoId });
    return;
  }

  // Gate: both NF fields must be persisted
  if (!pedido.nota_fiscal_id || !pedido.chave_acesso_nf) {
    logger.info(LOG_SOURCE, "Fase1: NF incompleta, deixando para segunda chance", {
      pedidoId,
      hasNotaFiscalId: !!pedido.nota_fiscal_id,
      hasChaveAcesso: !!pedido.chave_acesso_nf,
    });
    return;
  }

  // Idempotency: skip if already has valid agrupamento (not 'pending')
  if (pedido.agrupamento_expedicao_id && pedido.agrupamento_expedicao_id !== "pending") {
    return;
  }

  // Recover stale pending before claiming (reusable outside preCriarAgrupamentosEmLote)
  await recuperarPendingTravados(supabase, [pedidoId]);

  // Atomic claim via existing RPC — prevents duplicate agrupamentos
  const { data: claimed, error: claimErr } = await supabase.rpc(
    "siso_claim_pedidos_para_agrupamento",
    { p_pedido_ids: [pedidoId] },
  );

  if (claimErr || !claimed || (claimed as PedidoClaimed[]).length === 0) {
    // Already claimed by another caller or no empresa_origem_id
    return;
  }

  const p = (claimed as PedidoClaimed[])[0];

  // Double-check NF after claim (guard against race where NF was cleared between pre-check and claim)
  if (!p.nota_fiscal_id) {
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: null })
      .eq("id", pedidoId)
      .eq("agrupamento_expedicao_id", "pending");
    return;
  }

  try {
    const { token } = await getValidTokenByEmpresa(p.empresa_origem_id);

    await runWithEmpresa(p.empresa_origem_id, async () => {
      // Create agrupamento with single NF
      const formaFreteId = p.forma_frete_id
        ? parseInt(p.forma_frete_id, 10)
        : undefined;
      const safeFormaFrete = isNaN(formaFreteId as number) ? undefined : formaFreteId;

      let agrupamentoId: number;
      try {
        const agrupamento = await criarAgrupamento(token, [p.nota_fiscal_id!], safeFormaFrete);
        agrupamentoId = agrupamento.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("já foi expedida")) {
          logger.warn(LOG_SOURCE, "Fase1: NF já expedida no Tiny", {
            pedidoId,
            nfId: String(p.nota_fiscal_id),
          });
          await supabase
            .from("siso_pedidos")
            .update({ agrupamento_expedicao_id: "expedido_externo" })
            .eq("id", pedidoId);
          return;
        }
        throw err;
      }

      logger.info(LOG_SOURCE, "Fase1: agrupamento criado", {
        pedidoId,
        agrupamentoId: String(agrupamentoId),
      });

      // Save agrupamento ID (replacing 'pending')
      await supabase
        .from("siso_pedidos")
        .update({ agrupamento_expedicao_id: String(agrupamentoId) })
        .eq("id", pedidoId);

      // Conclude agrupamento — non-fatal, same posture as existing service.
      // Mercado Envios orders auto-request pickup, so concluir may return 400.
      try {
        await concluirAgrupamento(token, agrupamentoId);
      } catch (err) {
        logger.warn(LOG_SOURCE, "Fase1: não foi possível concluir agrupamento", {
          pedidoId,
          agrupamentoId: String(agrupamentoId),
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Discover expedicao_id via obterAgrupamento
      const details = await obterAgrupamento(token, agrupamentoId);

      if (!details.expedicoes || details.expedicoes.length === 0) {
        logger.warn(LOG_SOURCE, "Fase1: agrupamento sem expedições", {
          pedidoId,
          agrupamentoId: String(agrupamentoId),
        });
        return;
      }

      // Single pedido per agrupamento → use first expedition
      const exp = details.expedicoes[0];

      // Save expedicao_id — fase-1 stops here, does NOT fetch etiqueta/ZPL
      await supabase
        .from("siso_pedidos")
        .update({ expedicao_id: String(exp.id) })
        .eq("id", pedidoId);

      logger.info(LOG_SOURCE, "Fase1: agrupamento completo (sem etiqueta)", {
        pedidoId,
        agrupamentoId: String(agrupamentoId),
        expedicaoId: String(exp.id),
      });
    });
  } catch (err) {
    // Clear pending so pedido can be retried by future entrypoints
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: null, expedicao_id: null })
      .eq("id", pedidoId)
      .eq("agrupamento_expedicao_id", "pending");

    logger.error(LOG_SOURCE, "Fase1: falha ao criar agrupamento", {
      pedidoId,
      empresaId: p.empresa_origem_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createServiceClient>;

/**
 * Process all pedidos for one empresa: get token once, then create
 * one agrupamento per pedido within the empresa's rate limit.
 */
async function processarPedidosEmpresa(
  supabase: SupabaseClient,
  empresaId: string,
  pedidos: PedidoClaimed[],
): Promise<void> {
  const pedidoIds = pedidos.map((p) => p.id);

  try {
    const { token } = await getValidTokenByEmpresa(empresaId);

    await runWithEmpresa(empresaId, async () => {
      for (const pedido of pedidos) {
        await processarPedido(supabase, token, pedido);
      }
    });
  } catch (err) {
    // Clear pending so pedidos can be retried
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: null, expedicao_id: null })
      .in("id", pedidoIds)
      .eq("agrupamento_expedicao_id", "pending");

    logger.error(LOG_SOURCE, "Falha ao processar agrupamentos da empresa", {
      empresaId,
      pedidoIds,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Create a single Tiny agrupamento for one pedido, download its ZPL label,
 * and cache everything in DB.
 */
async function processarPedido(
  supabase: SupabaseClient,
  token: string,
  pedido: PedidoClaimed,
): Promise<void> {
  try {
    if (!pedido.nota_fiscal_id) {
      logger.warn(LOG_SOURCE, "Pedido sem nota fiscal, skip", { pedidoId: pedido.id });
      return;
    }

    // 1. Create agrupamento with single NF
    const formaFreteId = pedido.forma_frete_id
      ? parseInt(pedido.forma_frete_id, 10)
      : undefined;
    const safeFormaFrete = isNaN(formaFreteId as number) ? undefined : formaFreteId;

    let agrupamentoId: number;
    try {
      const agrupamento = await criarAgrupamento(token, [pedido.nota_fiscal_id], safeFormaFrete);
      agrupamentoId = agrupamento.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("já foi expedida")) {
        logger.warn(LOG_SOURCE, "NF já expedida no Tiny", {
          pedidoId: pedido.id,
          nfId: String(pedido.nota_fiscal_id),
        });
        await supabase
          .from("siso_pedidos")
          .update({ agrupamento_expedicao_id: "expedido_externo" })
          .eq("id", pedido.id);
        return;
      }
      throw err;
    }

    logger.info(LOG_SOURCE, "Agrupamento criado", {
      pedidoId: pedido.id,
      agrupamentoId: String(agrupamentoId),
    });

    // Save agrupamento ID (replacing 'pending')
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: String(agrupamentoId) })
      .eq("id", pedido.id);

    // 2. Conclude agrupamento (required before labels are available)
    //    Non-fatal: Mercado Envios orders auto-request pickup, so concluir
    //    may return 400. We still attempt to fetch labels regardless.
    try {
      await concluirAgrupamento(token, agrupamentoId);
    } catch (err) {
      logger.warn(LOG_SOURCE, "Não foi possível concluir agrupamento (tentando etiqueta mesmo assim)", {
        pedidoId: pedido.id,
        agrupamentoId: String(agrupamentoId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Get agrupamento details to find expedition ID
    const details = await obterAgrupamento(token, agrupamentoId);

    if (!details.expedicoes || details.expedicoes.length === 0) {
      logger.warn(LOG_SOURCE, "Agrupamento sem expedições", {
        pedidoId: pedido.id,
        agrupamentoId: String(agrupamentoId),
      });
      return;
    }

    // Single pedido per agrupamento → use first expedition
    const exp = details.expedicoes[0];

    // 4. Fetch label
    const etiquetas = await obterEtiquetasExpedicao(token, agrupamentoId, exp.id);

    if (!etiquetas.urls || etiquetas.urls.length === 0) {
      // Save expedicao_id even without label (retry can use it)
      await supabase
        .from("siso_pedidos")
        .update({ expedicao_id: String(exp.id) })
        .eq("id", pedido.id);
      logger.warn(LOG_SOURCE, "Sem URL de etiqueta", {
        pedidoId: pedido.id,
        agrupamentoId: String(agrupamentoId),
        expedicaoId: String(exp.id),
      });
      return;
    }

    const url = etiquetas.urls[0];
    const zpl = await baixarZpl(url);

    await salvarEtiqueta(supabase, pedido.id, url, zpl, exp.id);

    logger.info(LOG_SOURCE, "Etiqueta ZPL pré-cacheada", {
      pedidoId: pedido.id,
      agrupamentoId: String(agrupamentoId),
      expedicaoId: String(exp.id),
      cached: String(!!zpl),
    });
  } catch (err) {
    // Clear pending so it can be retried
    await supabase
      .from("siso_pedidos")
      .update({ agrupamento_expedicao_id: null, expedicao_id: null })
      .eq("id", pedido.id)
      .eq("agrupamento_expedicao_id", "pending");

    logger.error(LOG_SOURCE, "Falha ao pré-criar agrupamento", {
      pedidoId: pedido.id,
      empresaId: pedido.empresa_origem_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Smart retry for a single agrupamento (1 pedido) — handles each state:
 *
 * 1. Agrupamento not found (404) → clear agrupamento_expedicao_id
 * 2. Exists but not concluded → conclude, then fetch label
 * 3. Concluded → fetch label
 */
async function retryAgrupamento(
  supabase: SupabaseClient,
  token: string,
  agrupamentoId: number,
  pedido: {
    id: string;
    empresa_origem_id: string;
    agrupamento_expedicao_id: string | null;
    expedicao_id: string | null;
    etiqueta_url: string | null;
    etiqueta_zpl: string | null;
  },
): Promise<void> {
  // 1. Try to conclude (idempotent — if already concluded, Tiny returns 400)
  try {
    await concluirAgrupamento(token, agrupamentoId);
    logger.info(LOG_SOURCE, "Agrupamento concluído no retry", {
      agrupamentoId: String(agrupamentoId),
      pedidoId: pedido.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 = agrupamento doesn't exist → clear IDs for re-creation
    if (msg.includes("404")) {
      logger.warn(LOG_SOURCE, "Agrupamento não encontrado no Tiny (404) — limpando para re-criação", {
        agrupamentoId: String(agrupamentoId),
        pedidoId: pedido.id,
      });
      await supabase
        .from("siso_pedidos")
        .update({ agrupamento_expedicao_id: null, expedicao_id: null, etiqueta_url: null })
        .eq("id", pedido.id);
      return;
    }
    // 400 = already concluded (Mercado Envios etc) — continue to fetch label
    if (!msg.includes("400")) {
      throw err;
    }
  }

  // 2. Fast path: expedicao_id already saved → skip obterAgrupamento
  if (pedido.expedicao_id) {
    await fetchAndSaveLabel(supabase, token, agrupamentoId, parseInt(pedido.expedicao_id, 10), pedido.id);
    return;
  }

  // 3. Slow path: discover expedition via obterAgrupamento
  const details = await obterAgrupamento(token, agrupamentoId);

  if (!details.expedicoes || details.expedicoes.length === 0) {
    logger.warn(LOG_SOURCE, "Agrupamento sem expedições no retry", {
      agrupamentoId: String(agrupamentoId),
      pedidoId: pedido.id,
    });
    return;
  }

  // Single pedido per agrupamento → use first expedition
  const exp = details.expedicoes[0];
  await fetchAndSaveLabel(supabase, token, agrupamentoId, exp.id, pedido.id);
}

/** Fetch label for a single expedition and save to DB */
async function fetchAndSaveLabel(
  supabase: SupabaseClient,
  token: string,
  agrupamentoId: number,
  expedicaoId: number,
  pedidoId: string,
): Promise<void> {
  try {
    const etiquetas = await obterEtiquetasExpedicao(token, agrupamentoId, expedicaoId);

    if (!etiquetas.urls || etiquetas.urls.length === 0) {
      logger.warn(LOG_SOURCE, "Sem URL de etiqueta no retry", {
        agrupamentoId: String(agrupamentoId),
        expedicaoId: String(expedicaoId),
        pedidoId,
      });
      return;
    }

    const url = etiquetas.urls[0];
    const zpl = await baixarZpl(url);
    await salvarEtiqueta(supabase, pedidoId, url, zpl, expedicaoId);

    logger.info(LOG_SOURCE, "Etiqueta recuperada no retry", {
      pedidoId,
      agrupamentoId: String(agrupamentoId),
      expedicaoId: String(expedicaoId),
      cached: String(!!zpl),
    });
  } catch (err) {
    logger.warn(LOG_SOURCE, "Falha ao buscar etiqueta no retry", {
      agrupamentoId: String(agrupamentoId),
      expedicaoId: String(expedicaoId),
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function salvarEtiqueta(
  supabase: SupabaseClient,
  pedidoId: string,
  url: string,
  zpl: string | null,
  expedicaoId?: number,
): Promise<void> {
  // Only cache ZPL if download was successful. Saving null ZPL with a URL
  // leaves the pedido in a state where fast path always fails and the URL
  // may be stale. Better to leave both null so fallback creates fresh.
  const updateData: Record<string, string | null> = { etiqueta_url: url };
  if (expedicaoId != null) {
    updateData.expedicao_id = String(expedicaoId);
  }
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
 *
 * Exported so fase-1 entrypoints can recover stale pending before claiming.
 */
export async function recuperarPendingTravados(
  supabase: SupabaseClient,
  pedidoIds: string[],
): Promise<void> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("siso_pedidos")
    .update({ agrupamento_expedicao_id: null, expedicao_id: null })
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
