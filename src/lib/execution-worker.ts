/**
 * Execution worker — processes the siso_fila_execucao queue.
 *
 * Picks pending jobs one at a time, respects Tiny API rate limits,
 * and retries with exponential backoff on failure.
 *
 * Stock posting logic:
 * - "propria": calls Tiny lancarEstoque on origin empresa (order-level deduction)
 * - "transferencia": deducts stock item-by-item from support empresas via
 *   POST /estoque/{id} with tipo="S", following tier order
 * - "oc": no stock to post. Marked as done.
 */

import { createServiceClient } from "./supabase-server";
import { lancarEstoque, movimentarEstoque, buscarProdutoPorSku } from "./tiny-api";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { checkRateLimit, registerApiCall, waitForRateLimit } from "./rate-limiter";
import { getOrdemDeducao } from "./grupo-resolver";
import { getEmpresaById } from "./empresa-lookup";
import { logger } from "./logger";

interface FilaJob {
  id: string;
  pedido_id: string;
  tipo: string;
  empresa_id: string;
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

  const now = new Date().toISOString();
  const { data: jobs, error } = await supabase
    .from("siso_fila_execucao")
    .select(
      "id, pedido_id, tipo, empresa_id, decisao, tentativas, max_tentativas",
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
    const rateStatus = await checkRateLimit(job.empresa_id);
    if (!rateStatus.allowed) {
      logger.info("worker", "Rate limited, pausing queue", {
        empresaId: job.empresa_id,
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
      .eq("status", "pendente")
      .select("id")
      .single();

    if (!claimed) {
      result.skipped++;
      continue;
    }

    // Skip jobs whose order was cancelled while queued
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

      await supabase
        .from("siso_fila_execucao")
        .update({
          status: "concluido",
          executado_em: new Date().toISOString(),
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", job.id);

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
        empresaId: job.empresa_id,
        decisao: job.decisao,
      });

      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const tentativas = job.tentativas + 1;
      const maxed = tentativas >= job.max_tentativas;

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
        empresaId: job.empresa_id,
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

  logger.info("worker", `Decisão "oc" — sem lançamento de estoque`, {
    pedidoId: job.pedido_id,
    decisao: job.decisao,
  });
}

/** propria: use Tiny's order-level stock posting (deducts from origin empresa) */
async function executarSaidaPropria(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

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

  const { token } = await getValidTokenByEmpresa(job.empresa_id);

  await registerApiCall(job.empresa_id, "POST /pedidos/{id}/lancar-estoque");
  await lancarEstoque(token, job.pedido_id);

  await supabase
    .from("siso_pedidos")
    .update({ estoque_lancado: true })
    .eq("id", job.pedido_id);

  logger.info("worker", "Estoque lançado no Tiny (própria)", {
    pedidoId: job.pedido_id,
    empresaId: job.empresa_id,
  });
}

/**
 * transferencia: deduct stock following tier order across empresas.
 *
 * Gets the deduction order from grupo-resolver. For each item,
 * traverses empresas in tier order until the full quantity is covered.
 */
async function executarSaidaTransferencia(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  const { data: pedido, error: pedidoErr } = await supabase
    .from("siso_pedidos")
    .select("numero, empresa_origem_id")
    .eq("id", job.pedido_id)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error(`Pedido ${job.pedido_id} não encontrado no banco`);
  }

  const empresaOrigem = await getEmpresaById(pedido.empresa_origem_id);
  if (!empresaOrigem) {
    throw new Error(`Empresa origem ${pedido.empresa_origem_id} não encontrada`);
  }

  // Get items NOT yet deducted
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
    });
    return;
  }

  // Get deduction order: empresa_id in job is the support empresa for transfer
  // We need to get grupo and resolve the full deduction order for the support side
  const empresaSuporte = await getEmpresaById(job.empresa_id);
  if (!empresaSuporte || !empresaSuporte.grupoId) {
    // Fallback: just use the single empresa
    await deductFromSingleEmpresa(job, pedido.numero, empresaOrigem.empresaNome, itens);
    return;
  }

  // Get all empresas ordered for deduction (excluding origin galpao for transfers)
  const ordemDeducao = await getOrdemDeducao(
    empresaSuporte.grupoId,
    job.empresa_id,
  );

  // For transfer, we only deduct from empresas that are NOT in the origin galpao
  const empresasDeducao = ordemDeducao.filter(
    (e) => e.galpaoId !== empresaOrigem.galpaoId,
  );

  if (empresasDeducao.length === 0) {
    // Fallback
    await deductFromSingleEmpresa(job, pedido.numero, empresaOrigem.empresaNome, itens);
    return;
  }

  const observacoes = `Saída para atender pedido ${pedido.numero} da ${empresaOrigem.empresaNome}`;

  let processed = 0;
  let errors = 0;
  const failedSkus: string[] = [];

  for (const item of itens) {
    try {
      let remaining = item.quantidade_pedida as number;

      for (const emp of empresasDeducao) {
        if (remaining <= 0) break;

        let token: string;
        try {
          const result = await getValidTokenByEmpresa(emp.empresaId);
          token = result.token;
        } catch {
          continue; // Skip empresa without token
        }

        // Find product in this empresa
        await waitForRateLimit(emp.empresaId);
        await registerApiCall(emp.empresaId, "GET /produtos?codigo=");
        const produto = await buscarProdutoPorSku(token, item.sku);
        if (!produto) continue;

        // Get configured deposit
        const { data: conn } = await supabase
          .from("siso_tiny_connections")
          .select("deposito_id")
          .eq("empresa_id", emp.empresaId)
          .eq("ativo", true)
          .single();

        const depositoId = conn?.deposito_id ?? null;

        // Deduct stock
        await waitForRateLimit(emp.empresaId);
        await registerApiCall(emp.empresaId, "POST /estoque/{id}");

        const qtdDeducao = remaining; // Deduct full remaining (Tiny will reject if not enough)
        await movimentarEstoque(token, produto.id, {
          tipo: "S",
          quantidade: qtdDeducao,
          deposito: depositoId ? { id: depositoId } : undefined,
          observacoes,
        });

        remaining -= qtdDeducao;

        logger.info("worker", `Saída lançada: ${item.sku} x${qtdDeducao} de ${emp.empresaNome}`, {
          pedidoId: job.pedido_id,
          sku: item.sku,
          quantidade: qtdDeducao,
          empresaId: emp.empresaId,
        });

        await sleep(500);
      }

      // Mark item as deducted
      await supabase
        .from("siso_pedido_itens")
        .update({ estoque_saida_lancada: true })
        .eq("pedido_id", job.pedido_id)
        .eq("produto_id", item.produto_id);

      processed++;
      await sleep(500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors++;
      failedSkus.push(item.sku);
      logger.error("worker", `Falha ao lançar saída: ${item.sku}`, {
        pedidoId: job.pedido_id,
        sku: item.sku,
        empresaId: job.empresa_id,
        error: msg,
      });
    }
  }

  if (errors > 0) {
    throw new Error(
      `Falha em ${errors} de ${errors + processed} itens (SKUs: ${failedSkus.join(", ")})`,
    );
  }

  logger.info("worker", "Saídas de transferência concluídas", {
    pedidoId: job.pedido_id,
    empresaId: job.empresa_id,
    totalItens: itens.length,
    processed,
  });
}

/** Fallback: deduct from a single empresa (backwards compat) */
async function deductFromSingleEmpresa(
  job: FilaJob,
  pedidoNumero: string,
  nomeOrigem: string,
  itens: Array<{
    produto_id: number;
    produto_id_suporte: number | null;
    sku: string;
    descricao: string;
    quantidade_pedida: number;
    estoque_saida_lancada: boolean | null;
  }>,
): Promise<void> {
  const supabase = createServiceClient();
  const { token } = await getValidTokenByEmpresa(job.empresa_id);

  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("empresa_id", job.empresa_id)
    .eq("ativo", true)
    .single();

  const depositoId = conn?.deposito_id ?? null;
  const observacoes = `Saída para atender pedido ${pedidoNumero} da ${nomeOrigem}`;

  let processed = 0;
  let errors = 0;
  const failedSkus: string[] = [];

  for (const item of itens) {
    try {
      let produtoIdSuporte = item.produto_id_suporte as number | null;

      if (!produtoIdSuporte) {
        await waitForRateLimit(job.empresa_id);
        await registerApiCall(job.empresa_id, "GET /produtos?codigo=");
        const produto = await buscarProdutoPorSku(token, item.sku);
        produtoIdSuporte = produto?.id ?? null;
        if (produtoIdSuporte) await sleep(500);
      }

      if (!produtoIdSuporte) {
        errors++;
        failedSkus.push(item.sku);
        continue;
      }

      await waitForRateLimit(job.empresa_id);
      await registerApiCall(job.empresa_id, "POST /estoque/{id}");

      await movimentarEstoque(token, produtoIdSuporte, {
        tipo: "S",
        quantidade: item.quantidade_pedida,
        deposito: depositoId ? { id: depositoId } : undefined,
        observacoes,
      });

      await supabase
        .from("siso_pedido_itens")
        .update({ estoque_saida_lancada: true })
        .eq("pedido_id", job.pedido_id)
        .eq("produto_id", item.produto_id);

      processed++;
      await sleep(500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors++;
      failedSkus.push(item.sku);
      logger.error("worker", `Falha ao lançar saída: ${item.sku}`, {
        pedidoId: job.pedido_id,
        sku: item.sku,
        empresaId: job.empresa_id,
        error: msg,
      });
    }
  }

  if (errors > 0) {
    throw new Error(
      `Falha em ${errors} de ${errors + processed} itens (SKUs: ${failedSkus.join(", ")})`,
    );
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
