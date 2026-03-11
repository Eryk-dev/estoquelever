/**
 * Agrupamento (expedition grouping) pre-creation service.
 *
 * Called fire-and-forget when separation concludes (pedidos → "separado").
 * Groups pedidos by empresa_origem_id, creates a single Tiny agrupamento
 * per empresa (batch), downloads ZPL labels, and caches everything in DB.
 *
 * At packing time, the ZPL is already cached — we just send it to PrintNode
 * without any Tiny API calls, cutting the bip-to-print delay to ~1s.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { criarAgrupamento, concluirAgrupamento, obterEtiquetasAgrupamento } from "@/lib/tiny-api";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "agrupamento-service";

interface PedidoParaAgrupamento {
  id: string;
  numero: string;
  empresa_origem_id: string;
}

/**
 * Pre-create Tiny agrupamentos in batch for pedidos that just became "separado".
 * Groups by empresa, creates one agrupamento per empresa, downloads ZPL labels,
 * and caches them in etiqueta_zpl column.
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
    .select("id, numero, empresa_origem_id")
    .in("id", pedidoIds)
    .not("empresa_origem_id", "is", null);

  if (fetchErr || !pedidos || pedidos.length === 0) {
    logger.error(LOG_SOURCE, "Falha ao buscar pedidos para agrupamento", {
      pedidoIds,
      error: fetchErr?.message,
    });
    return;
  }

  // Group by empresa_origem_id
  const porEmpresa = new Map<string, PedidoParaAgrupamento[]>();
  for (const p of pedidos) {
    const empresaId = p.empresa_origem_id!;
    const lista = porEmpresa.get(empresaId) ?? [];
    lista.push({ id: p.id, numero: p.numero, empresa_origem_id: empresaId });
    porEmpresa.set(empresaId, lista);
  }

  // Process each empresa in parallel
  const promises = Array.from(porEmpresa.entries()).map(
    ([empresaId, pedidosEmpresa]) =>
      processarEmpresa(supabase, empresaId, pedidosEmpresa),
  );

  await Promise.allSettled(promises);
}

// ─── Internal ────────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createServiceClient>;

async function processarEmpresa(
  supabase: SupabaseClient,
  empresaId: string,
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

    // 1. Create single agrupamento for all pedidos of this empresa
    const agrupamento = await criarAgrupamento(token, idsTiny);
    const agrupamentoId = agrupamento.id;

    logger.info(LOG_SOURCE, "Agrupamento criado em lote", {
      empresaId,
      agrupamentoId: String(agrupamentoId),
      qtdPedidos: String(idsTiny.length),
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

    // 3. Download ZPL content from each URL in parallel
    const downloads = await Promise.allSettled(
      etiquetas.urls.map((url) => baixarZpl(url)),
    );

    const zplContents = downloads.map((r) =>
      r.status === "fulfilled" ? r.value : null,
    );

    // 4. Map URLs/ZPL to pedidos and save
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
      pedidoIds: pedidos.map((p) => p.id),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Download ZPL content from a Tiny etiqueta URL.
 * Returns the raw ZPL text, or null on failure.
 */
async function baixarZpl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.warn(LOG_SOURCE, "Falha ao baixar ZPL", {
        url,
        status: String(res.status),
      });
      return null;
    }
    const text = await res.text();
    if (!text || !text.trimStart().startsWith("^")) {
      logger.warn(LOG_SOURCE, "Conteúdo baixado não é ZPL válido", {
        url,
        contentLength: String(text?.length ?? 0),
        preview: text?.substring(0, 100) ?? "(vazio)",
      });
      return null;
    }
    return text;
  } catch (err) {
    logger.warn(LOG_SOURCE, "Erro de rede ao baixar ZPL", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
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
