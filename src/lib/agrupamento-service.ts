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
