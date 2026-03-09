/**
 * Execution worker — processes the siso_fila_execucao queue.
 *
 * Picks pending jobs one at a time, respects Tiny API rate limits,
 * and retries with exponential backoff on failure.
 *
 * Stock posting logic:
 * - "propria": calls Tiny API to post stock in origin branch (order exists there)
 * - "transferencia": order only exists in origin — can't post via API in support.
 *   Marked as done; physical transfer + manual stock handled outside SISO.
 * - "oc": no stock to post. Marked as done.
 */

import { createServiceClient } from "./supabase-server";
import { lancarEstoque } from "./tiny-api";
import { getValidTokenByFilial } from "./tiny-oauth";
import { checkRateLimit, registerApiCall } from "./rate-limiter";
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

      // Update pedido status to concluido
      await supabase
        .from("siso_pedidos")
        .update({
          status: "concluido",
          processado_em: new Date().toISOString(),
        })
        .eq("id", job.pedido_id);

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

  // Only "propria" gets automated stock posting.
  // "transferencia": order lives in origin account only — can't post stock via
  // support account API. Physical transfer happens outside SISO.
  // "oc": no stock exists to post.
  if (job.decisao !== "propria") {
    logger.info("worker", `Decisão "${job.decisao}" — sem lançamento automático`, {
      pedidoId: job.pedido_id,
      decisao: job.decisao,
    });
    return;
  }

  // Get token for the branch where the order lives
  const { token } = await getValidTokenByFilial(job.filial_execucao);

  // Register the API call for shared rate limit tracking
  await registerApiCall(job.filial_execucao, "POST /pedidos/{id}/lancar-estoque");

  // Post stock
  await lancarEstoque(token, job.pedido_id);

  logger.info("worker", "Estoque lançado no Tiny", {
    pedidoId: job.pedido_id,
    filial: job.filial_execucao,
  });
}
