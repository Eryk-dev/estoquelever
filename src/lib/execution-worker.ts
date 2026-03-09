/**
 * Execution worker — processes the siso_fila_execucao queue.
 *
 * Picks pending jobs one at a time, respects Tiny API rate limits,
 * and retries with exponential backoff on failure.
 *
 * Stock posting logic:
 * - "propria": calls Tiny lancarEstoque on origin branch (order-level deduction)
 * - "transferencia": deducts stock item-by-item from support branch via
 *   POST /estoque/{id} with tipo="S" (order doesn't exist in support account)
 * - "oc": no stock to post. Marked as done.
 */

import { createServiceClient } from "./supabase-server";
import { lancarEstoque, movimentarEstoque, buscarProdutoPorSku } from "./tiny-api";
import { getValidTokenByFilial } from "./tiny-oauth";
import { checkRateLimit, registerApiCall, waitForRateLimit } from "./rate-limiter";
import { getNomeFilial } from "./cnpj-filial";
import { logger } from "./logger";

interface FilaJob {
  id: string;
  pedido_id: string;
  tipo: string;
  filial_execucao: "CWB" | "SP";
  decisao: string;
  tentativas: number;
  max_tentativas: number;
}

export interface ProcessResult {
  processed: number;
  errors: number;
  skipped: number;
  rateLimited: boolean;
  jobs: { id: string; pedidoId: string; status: string; erro?: string }[];
}

/**
 * Process up to `limit` pending jobs from the execution queue.
 * Call this from a cron endpoint or after each approval.
 */
export async function processQueue(limit: number = 5): Promise<ProcessResult> {
  const supabase = createServiceClient();
  const result: ProcessResult = {
    processed: 0,
    errors: 0,
    skipped: 0,
    rateLimited: false,
    jobs: [],
  };

  // Pick next pending jobs (FIFO, respecting retry timing)
  const now = new Date().toISOString();
  const { data: jobs, error } = await supabase
    .from("siso_fila_execucao")
    .select(
      "id, pedido_id, tipo, filial_execucao, decisao, tentativas, max_tentativas",
    )
    .eq("status", "pendente")
    .or(`proximo_retry_em.is.null,proximo_retry_em.lte.${now}`)
    .order("criado_em", { ascending: true })
    .limit(limit);

  if (error || !jobs?.length) {
    return result;
  }

  for (const job of jobs as FilaJob[]) {
    // Check rate limit before each job
    const rateStatus = await checkRateLimit(job.filial_execucao);
    if (!rateStatus.allowed) {
      logger.info("worker", "Rate limited, pausing queue", {
        filial: job.filial_execucao,
        remaining: rateStatus.remaining,
        waitMs: rateStatus.waitMs,
      });
      result.rateLimited = true;
      break;
    }

    // Mark as executing (atomic claim)
    const { data: claimed } = await supabase
      .from("siso_fila_execucao")
      .update({
        status: "executando",
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "pendente") // prevent double-processing
      .select("id")
      .single();

    if (!claimed) {
      result.skipped++;
      continue;
    }

    // GAP 2: Skip jobs whose order was cancelled while queued
    const { data: orderCheck } = await supabase
      .from("siso_pedidos")
      .select("status")
      .eq("id", job.pedido_id)
      .single();

    if (orderCheck?.status === "cancelado") {
      await supabase
        .from("siso_fila_execucao")
        .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
        .eq("id", job.id);
      result.skipped++;
      logger.info("worker", "Job skipped — pedido cancelado", { pedidoId: job.pedido_id });
      continue;
    }

    try {
      await executeJob(job);

      // Mark job as completed
      await supabase
        .from("siso_fila_execucao")
        .update({
          status: "concluido",
          executado_em: new Date().toISOString(),
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", job.id);

      // Update pedido status — only if still "executando" (don't overwrite "cancelado")
      await supabase
        .from("siso_pedidos")
        .update({
          status: "concluido",
          processado_em: new Date().toISOString(),
        })
        .eq("id", job.pedido_id)
        .eq("status", "executando");

      result.processed++;
      result.jobs.push({
        id: job.id,
        pedidoId: job.pedido_id,
        status: "concluido",
      });

      logger.info("worker", "Job completed", {
        jobId: job.id,
        pedidoId: job.pedido_id,
        filial: job.filial_execucao,
        decisao: job.decisao,
      });

      // Breathing room between jobs (rate limit safety)
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const tentativas = job.tentativas + 1;
      const maxed = tentativas >= job.max_tentativas;

      // Exponential backoff: 30s, 60s, 120s
      const retryDelay = Math.min(
        30_000 * Math.pow(2, tentativas - 1),
        120_000,
      );

      await supabase
        .from("siso_fila_execucao")
        .update({
          status: maxed ? "erro" : "pendente",
          tentativas,
          erro: errorMsg,
          proximo_retry_em: maxed
            ? null
            : new Date(Date.now() + retryDelay).toISOString(),
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", job.id);

      // If all retries exhausted, mark pedido as error
      if (maxed) {
        await supabase
          .from("siso_pedidos")
          .update({
            status: "erro",
            erro: `Falha após ${tentativas} tentativas: ${errorMsg}`,
          })
          .eq("id", job.pedido_id);
      }

      result.errors++;
      result.jobs.push({
        id: job.id,
        pedidoId: job.pedido_id,
        status: maxed ? "erro" : "retry",
        erro: errorMsg,
      });

      logger.error("worker", "Job failed", {
        jobId: job.id,
        pedidoId: job.pedido_id,
        filial: job.filial_execucao,
        tentativas,
        maxed,
        error: errorMsg,
      });
    }
  }

  return result;
}

// ─── Job execution ──────────────────────────────────────────────────────────

async function executeJob(job: FilaJob): Promise<void> {
  if (job.tipo !== "lancar_estoque") {
    throw new Error(`Tipo de job desconhecido: ${job.tipo}`);
  }

  if (job.decisao === "propria") {
    await executarSaidaPropria(job);
    return;
  }

  if (job.decisao === "transferencia") {
    await executarSaidaTransferencia(job);
    return;
  }

  // "oc" — no stock exists to post
  logger.info("worker", `Decisão "oc" — sem lançamento de estoque`, {
    pedidoId: job.pedido_id,
    decisao: job.decisao,
  });
}

/** propria: use Tiny's order-level stock posting (deducts from origin) */
async function executarSaidaPropria(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  // Idempotency: skip if stock was already posted (prevents double-deduction on retry)
  const { data: pedido } = await supabase
    .from("siso_pedidos")
    .select("estoque_lancado")
    .eq("id", job.pedido_id)
    .single();

  if (pedido?.estoque_lancado) {
    logger.info("worker", "Estoque já lançado (retry idempotente)", {
      pedidoId: job.pedido_id,
    });
    return;
  }

  const { token } = await getValidTokenByFilial(job.filial_execucao);

  await registerApiCall(job.filial_execucao, "POST /pedidos/{id}/lancar-estoque");
  await lancarEstoque(token, job.pedido_id);

  // Mark as posted for idempotency
  await supabase
    .from("siso_pedidos")
    .update({ estoque_lancado: true })
    .eq("id", job.pedido_id);

  logger.info("worker", "Estoque lançado no Tiny (própria)", {
    pedidoId: job.pedido_id,
    filial: job.filial_execucao,
  });
}

/**
 * transferencia: deduct stock item-by-item from the support branch.
 *
 * The order lives in the ORIGIN account, but stock is fulfilled by the
 * SUPPORT branch. Since the order doesn't exist in the support account,
 * we can't use lancarEstoque — we do manual "S" (saída) movements
 * for each item via POST /estoque/{idProduto}.
 *
 * Uses `estoque_saida_lancada` on siso_pedido_itens for retry idempotency.
 */
async function executarSaidaTransferencia(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  // Get order info for the description
  const { data: pedido, error: pedidoErr } = await supabase
    .from("siso_pedidos")
    .select("numero, filial_origem")
    .eq("id", job.pedido_id)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error(`Pedido ${job.pedido_id} não encontrado no banco`);
  }

  const filialOrigem = pedido.filial_origem as "CWB" | "SP";
  const nomeOrigem = getNomeFilial(filialOrigem);

  // Get items NOT yet deducted (retry-safe)
  const { data: itens, error: itensErr } = await supabase
    .from("siso_pedido_itens")
    .select("produto_id, produto_id_suporte, sku, descricao, quantidade_pedida, estoque_saida_lancada")
    .eq("pedido_id", job.pedido_id)
    .or("estoque_saida_lancada.is.null,estoque_saida_lancada.eq.false");

  if (itensErr) {
    throw new Error(`Erro ao buscar itens: ${itensErr.message}`);
  }

  if (!itens?.length) {
    logger.info("worker", "Todos os itens já tiveram saída lançada", {
      pedidoId: job.pedido_id,
      filial: job.filial_execucao,
    });
    return;
  }

  // Token for the support branch (where stock will be deducted)
  const { token } = await getValidTokenByFilial(job.filial_execucao);

  // Get configured deposit for support branch
  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("filial", job.filial_execucao)
    .eq("ativo", true)
    .single();

  const depositoId = conn?.deposito_id ?? null;

  const observacoes = `Saída para atender pedido ${pedido.numero} da ${nomeOrigem} (${filialOrigem})`;

  let processed = 0;
  let errors = 0;
  const failedSkus: string[] = [];

  for (const item of itens) {
    try {
      // Use pre-cached product ID from webhook enrichment; fall back to SKU search
      let produtoIdSuporte = item.produto_id_suporte as number | null;

      if (!produtoIdSuporte) {
        await waitForRateLimit(job.filial_execucao);
        await registerApiCall(job.filial_execucao, "GET /produtos?codigo=");
        const produto = await buscarProdutoPorSku(token, item.sku);
        produtoIdSuporte = produto?.id ?? null;
        if (produtoIdSuporte) await sleep(500);
      }

      if (!produtoIdSuporte) {
        logger.warn("worker", `SKU ${item.sku} não encontrado em ${job.filial_execucao}`, {
          pedidoId: job.pedido_id,
          sku: item.sku,
          filial: job.filial_execucao,
        });
        errors++;
        failedSkus.push(item.sku);
        continue;
      }

      // Deduct stock
      await waitForRateLimit(job.filial_execucao);
      await registerApiCall(job.filial_execucao, "POST /estoque/{id}");

      await movimentarEstoque(token, produtoIdSuporte, {
        tipo: "S",
        quantidade: item.quantidade_pedida,
        deposito: depositoId ? { id: depositoId } : undefined,
        observacoes,
      });

      // Mark item as deducted (idempotency for retries)
      await supabase
        .from("siso_pedido_itens")
        .update({ estoque_saida_lancada: true })
        .eq("pedido_id", job.pedido_id)
        .eq("produto_id", item.produto_id);

      processed++;
      logger.info("worker", `Saída lançada: ${item.sku} x${item.quantidade_pedida}`, {
        pedidoId: job.pedido_id,
        sku: item.sku,
        quantidade: item.quantidade_pedida,
        filial: job.filial_execucao,
      });

      // Breathing room between items
      await sleep(500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors++;
      failedSkus.push(item.sku);
      logger.error("worker", `Falha ao lançar saída: ${item.sku}`, {
        pedidoId: job.pedido_id,
        sku: item.sku,
        filial: job.filial_execucao,
        error: msg,
      });
    }
  }

  // Any failure → throw to trigger retry. Items already deducted are
  // marked estoque_saida_lancada=true and will be skipped on retry.
  if (errors > 0) {
    throw new Error(
      `Falha em ${errors} de ${errors + processed} itens (SKUs: ${failedSkus.join(", ")})`,
    );
  }

  logger.info("worker", "Saídas de transferência concluídas", {
    pedidoId: job.pedido_id,
    filial: job.filial_execucao,
    totalItens: itens.length,
    processed,
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
