/**
 * Agrupamento (expedition grouping) pre-creation service.
 *
 * Called fire-and-forget when separation concludes (pedidos → "separado").
 * Groups pedidos by empresa_origem_id + shipping method (forma_envio_id,
 * forma_frete_id, transportador_id), creates one Tiny agrupamento per group,
 * downloads ZPL labels, and caches everything in DB.
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

interface PedidoParaAgrupamento {
  id: string;
  numero: string;
  empresa_origem_id: string;
  forma_envio_id: string | null;
  forma_frete_id: string | null;
  transportador_id: string | null;
}

/**
 * Build a grouping key from empresa + shipping fields.
 * Pedidos with the same key can be in the same Tiny agrupamento.
 */
function buildGroupKey(p: PedidoParaAgrupamento): string {
  return `${p.empresa_origem_id}|${p.forma_envio_id ?? ""}|${p.forma_frete_id ?? ""}|${p.transportador_id ?? ""}`;
}

/**
 * Pre-create Tiny agrupamentos in batch for pedidos that just became "separado".
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

  const { data: pedidos, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select("id, numero, empresa_origem_id, agrupamento_expedicao_id, forma_envio_id, forma_frete_id, transportador_id")
    .in("id", pedidoIds)
    .not("empresa_origem_id", "is", null)
    .is("agrupamento_expedicao_id", null);

  if (fetchErr) {
    logger.error(LOG_SOURCE, "Falha ao buscar pedidos para agrupamento", {
      pedidoIds,
      error: fetchErr.message,
    });
    return;
  }

  if (!pedidos || pedidos.length === 0) {
    logger.info(LOG_SOURCE, "Nenhum pedido precisa de agrupamento (já criados ou sem empresa)", {
      pedidoIds,
    });
    return;
  }

  // Group by empresa + shipping method (forma_envio, forma_frete, transportador)
  const groups = new Map<string, PedidoParaAgrupamento[]>();
  for (const p of pedidos) {
    const pedido: PedidoParaAgrupamento = {
      id: p.id,
      numero: p.numero,
      empresa_origem_id: p.empresa_origem_id!,
      forma_envio_id: p.forma_envio_id ?? null,
      forma_frete_id: p.forma_frete_id ?? null,
      transportador_id: p.transportador_id ?? null,
    };
    const key = buildGroupKey(pedido);
    const lista = groups.get(key) ?? [];
    lista.push(pedido);
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
  pedidos: PedidoParaAgrupamento[],
): Promise<void> {
  try {
    const { token } = await getValidTokenByEmpresa(empresaId);

    // Build Tiny numeric IDs
    const idsTiny: number[] = [];
    const pedidoPorTinyId = new Map<number, string>(); // tinyId → pedido UUID

    for (const p of pedidos) {
      const tinyId = parseInt(p.id, 10);
      if (isNaN(tinyId)) {
        logger.warn(LOG_SOURCE, "Pedido com id não numérico, skip", {
          pedidoId: p.id,
        });
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

    // Save agrupamento_expedicao_id on all pedidos
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
      // Single pedido
      await salvarEtiqueta(supabase, allPedidoIds[0], etiquetas.urls[0], zplContents[0]);
    } else if (etiquetas.urls.length === allPedidoIds.length) {
      // 1:1 mapping — urls in same order as idsPedidos
      const updates = allPedidoIds.map((pedidoId, i) =>
        salvarEtiqueta(supabase, pedidoId, etiquetas.urls[i], zplContents[i]),
      );
      await Promise.all(updates);
    } else {
      // Mismatch — store first URL/ZPL for all
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
    logger.error(LOG_SOURCE, "Falha ao pré-criar agrupamento", {
      empresaId,
      groupKey,
      pedidoIds: pedidos.map((p) => p.id),
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
