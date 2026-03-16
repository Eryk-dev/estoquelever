/**
 * Execution worker — processes the siso_fila_execucao queue.
 *
 * Picks pending jobs one at a time, respects Tiny API rate limits,
 * and retries with exponential backoff on failure.
 *
 * Stock posting flow (per decisao):
 * - ALL: insert marcadores on Tiny order
 * - "propria": marcadores → gerar NF → lançar estoque da NF
 * - "transferencia": marcadores → gerar NF on origin + movimentarEstoque on support empresas
 * - "oc": marcadores only (no NF, no stock)
 */

import { createServiceClient } from "./supabase-server";
import {
  criarMarcadoresPedido,
  gerarNotaFiscal,
  lancarEstoqueNota,
  movimentarEstoque,
  buscarProdutoPorSku,
} from "./tiny-api";
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

      logger.logError({
        error: err,
        source: "worker",
        message: `Job failed (tentativa ${tentativas}/${job.max_tentativas})`,
        category: errorMsg.includes("token") || errorMsg.includes("Token")
          ? "auth"
          : errorMsg.includes("rate") || errorMsg.includes("429")
            ? "infrastructure"
            : "external_api",
        severity: maxed ? "critical" : "error",
        pedidoId: job.pedido_id,
        empresaId: job.empresa_id,
        metadata: {
          jobId: job.id,
          decisao: job.decisao,
          tentativas,
          maxed,
          retryDelay: maxed ? null : retryDelay,
        },
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

  if (job.decisao === "oc") {
    await executarMarcadoresOnly(job);
    return;
  }

  logger.warn("worker", `Decisão desconhecida: ${job.decisao}`, {
    pedidoId: job.pedido_id,
    decisao: job.decisao,
  });
}

// ─── Shared: insert marcadores on Tiny order (idempotent) ────────────────────

async function inserirMarcadoresTiny(
  empresaId: string,
  token: string,
  pedidoId: string,
  marcadores: string[],
): Promise<void> {
  if (marcadores.length === 0) return;

  try {
    await waitForRateLimit(empresaId);
    await registerApiCall(empresaId, "POST /pedidos/{id}/marcadores");
    await criarMarcadoresPedido(token, pedidoId, marcadores);
    logger.info("worker", "Marcadores inseridos no pedido Tiny", {
      pedidoId,
      marcadores,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("400")) {
      logger.info("worker", "Marcadores já existem no pedido (idempotente)", { pedidoId });
    } else {
      throw err;
    }
  }
}

// ─── Shared: generate NF on origin empresa (idempotent via nota_fiscal_id) ───

async function gerarNotaFiscalPedido(
  empresaId: string,
  token: string,
  pedidoId: string,
  notaFiscalIdExistente: number | null,
): Promise<number | null> {
  if (notaFiscalIdExistente) return notaFiscalIdExistente;

  const supabase = createServiceClient();

  try {
    await waitForRateLimit(empresaId);
    await registerApiCall(empresaId, "POST /pedidos/{id}/gerar-nota-fiscal");
    const nota = await gerarNotaFiscal(token, pedidoId);

    await supabase
      .from("siso_pedidos")
      .update({ nota_fiscal_id: nota.id })
      .eq("id", pedidoId);

    logger.info("worker", "Nota fiscal gerada", {
      pedidoId,
      notaId: nota.id,
      numero: nota.numero,
    });

    return nota.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((msg.includes("400") || msg.includes("409")) && (msg.includes("nota fiscal") || msg.includes("Já existe"))) {
      logger.warn("worker", "NF já existente externamente", { pedidoId, error: msg });
      return null;
    }
    throw err;
  }
}

// ─── propria: marcadores → gerar NF → lançar estoque da NF ──────────────────

async function executarSaidaPropria(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  const { data: pedido } = await supabase
    .from("siso_pedidos")
    .select("estoque_lancado, marcadores, nota_fiscal_id")
    .eq("id", job.pedido_id)
    .single();

  if (pedido?.estoque_lancado) {
    logger.info("worker", "Estoque já lançado (retry idempotente)", {
      pedidoId: job.pedido_id,
    });
    return;
  }

  const { token } = await getValidTokenByEmpresa(job.empresa_id);
  const marcadores: string[] = pedido?.marcadores ?? [];

  // 1. Insert marcadores on Tiny order
  await inserirMarcadoresTiny(job.empresa_id, token, job.pedido_id, marcadores);
  await sleep(500);

  // 2. Generate NF
  const notaId = await gerarNotaFiscalPedido(
    job.empresa_id,
    token,
    job.pedido_id,
    pedido?.nota_fiscal_id ?? null,
  );

  if (!notaId) {
    // NF already existed externally — stock was likely already posted
    await supabase
      .from("siso_pedidos")
      .update({ estoque_lancado: true })
      .eq("id", job.pedido_id);
    logger.warn("worker", "NF externa — marcando estoque como lançado", {
      pedidoId: job.pedido_id,
    });
    return;
  }

  await sleep(500);

  // 3. Post stock from NF
  await waitForRateLimit(job.empresa_id);
  await registerApiCall(job.empresa_id, "POST /notas/{id}/lancar-estoque");
  await lancarEstoqueNota(token, notaId);

  await supabase
    .from("siso_pedidos")
    .update({ estoque_lancado: true })
    .eq("id", job.pedido_id);

  logger.info("worker", "Estoque lançado via NF (própria)", {
    pedidoId: job.pedido_id,
    notaId,
    empresaId: job.empresa_id,
  });
}

// ─── oc: only insert marcadores, no NF or stock ─────────────────────────────

async function executarMarcadoresOnly(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  const { data: pedido } = await supabase
    .from("siso_pedidos")
    .select("marcadores")
    .eq("id", job.pedido_id)
    .single();

  const { token } = await getValidTokenByEmpresa(job.empresa_id);
  const marcadores: string[] = pedido?.marcadores ?? [];

  await inserirMarcadoresTiny(job.empresa_id, token, job.pedido_id, marcadores);

  // Set compra fields so items appear in the compras module
  await supabase
    .from("siso_pedidos")
    .update({ status_separacao: "aguardando_compra" })
    .eq("id", job.pedido_id);

  await supabase
    .from("siso_pedido_itens")
    .update({ compra_status: "aguardando_compra" })
    .eq("pedido_id", job.pedido_id);

  logger.info("execution-worker", "Pedido OC enviado para modulo de compras", {
    pedidoId: job.pedido_id,
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
    .select("numero, empresa_origem_id, marcadores, nota_fiscal_id")
    .eq("id", job.pedido_id)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error(`Pedido ${job.pedido_id} não encontrado no banco`);
  }

  const empresaOrigem = await getEmpresaById(pedido.empresa_origem_id);
  if (!empresaOrigem) {
    throw new Error(`Empresa origem ${pedido.empresa_origem_id} não encontrada`);
  }

  // ── Marcadores + NF on origin empresa ──────────────────────────────────────
  const { token: origemToken } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
  const marcadores: string[] = pedido.marcadores ?? [];

  await inserirMarcadoresTiny(pedido.empresa_origem_id, origemToken, job.pedido_id, marcadores);
  await sleep(500);

  await gerarNotaFiscalPedido(
    pedido.empresa_origem_id,
    origemToken,
    job.pedido_id,
    pedido.nota_fiscal_id ?? null,
  );
  await sleep(500);

  // ── Stock deduction: find ONE empresa that covers 100% of items ───────────

  // Get items NOT yet deducted
  const { data: itens, error: itensErr } = await supabase
    .from("siso_pedido_itens")
    .select("produto_id, sku, descricao, quantidade_pedida, estoque_saida_lancada")
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

  // Get enriched stock data per empresa (captured at webhook time)
  const { data: estoques } = await supabase
    .from("siso_pedido_item_estoques")
    .select("produto_id, empresa_id, disponivel")
    .eq("pedido_id", job.pedido_id);

  // Get deduction order (tier-based)
  const empresaSuporte = await getEmpresaById(job.empresa_id);
  if (!empresaSuporte || !empresaSuporte.grupoId) {
    throw new Error(`Empresa suporte ${job.empresa_id} sem grupo — não é possível transferir`);
  }

  const ordemDeducao = await getOrdemDeducao(
    empresaSuporte.grupoId,
    job.empresa_id,
  );

  // Only consider empresas NOT in the origin galpao
  const empresasDeducao = ordemDeducao.filter(
    (e) => e.galpaoId !== empresaOrigem.galpaoId,
  );

  // Find first empresa (by tier) that covers 100% of items
  let empresaEscolhida: typeof empresasDeducao[0] | null = null;

  for (const emp of empresasDeducao) {
    const cobreTudo = itens.every((item) => {
      const est = estoques?.find(
        (e) => e.empresa_id === emp.empresaId && e.produto_id === item.produto_id,
      );
      return est && est.disponivel >= (item.quantidade_pedida as number);
    });

    if (cobreTudo) {
      empresaEscolhida = emp;
      break;
    }
  }

  if (!empresaEscolhida) {
    const cobertura = empresasDeducao.map((emp) => {
      const cobertos = itens.filter((item) => {
        const est = estoques?.find(
          (e) => e.empresa_id === emp.empresaId && e.produto_id === item.produto_id,
        );
        return est && est.disponivel >= (item.quantidade_pedida as number);
      }).length;
      return `${emp.empresaNome}: ${cobertos}/${itens.length}`;
    });
    throw new Error(
      `Nenhuma empresa cobre 100% dos itens para transferência (${cobertura.join(", ")})`,
    );
  }

  logger.info("worker", `Empresa escolhida para transferência: ${empresaEscolhida.empresaNome}`, {
    pedidoId: job.pedido_id,
    empresaId: empresaEscolhida.empresaId,
    totalItens: itens.length,
  });

  // Deduct all items from the chosen empresa
  const { token: suporteToken } = await getValidTokenByEmpresa(empresaEscolhida.empresaId);

  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("empresa_id", empresaEscolhida.empresaId)
    .eq("ativo", true)
    .single();

  const depositoId = conn?.deposito_id ?? null;
  const observacoes = `Saída para atender pedido ${pedido.numero} da ${empresaOrigem.empresaNome}`;

  let processed = 0;
  let errors = 0;
  const failedSkus: string[] = [];

  for (const item of itens) {
    try {
      // Find product in this empresa by SKU
      await waitForRateLimit(empresaEscolhida.empresaId);
      await registerApiCall(empresaEscolhida.empresaId, "GET /produtos?codigo=");
      const produto = await buscarProdutoPorSku(suporteToken, item.sku);

      if (!produto) {
        errors++;
        failedSkus.push(item.sku);
        logger.logError({
          error: new Error(`Produto não encontrado na empresa suporte: ${item.sku}`),
          source: "worker",
          message: `Produto não encontrado na empresa suporte: ${item.sku}`,
          category: "business_logic",
          pedidoId: job.pedido_id,
          empresaId: empresaEscolhida.empresaId,
          empresaNome: empresaEscolhida.empresaNome,
          metadata: { sku: item.sku, operation: "transferencia" },
        });
        continue;
      }

      await sleep(500);

      // Deduct stock
      await waitForRateLimit(empresaEscolhida.empresaId);
      await registerApiCall(empresaEscolhida.empresaId, "POST /estoque/{id}");
      await movimentarEstoque(suporteToken, produto.id, {
        tipo: "S",
        quantidade: item.quantidade_pedida as number,
        deposito: depositoId ? { id: depositoId } : undefined,
        observacoes,
      });

      // Mark item as deducted
      await supabase
        .from("siso_pedido_itens")
        .update({
          estoque_saida_lancada: true,
          empresa_deducao_id: empresaEscolhida.empresaId,
        })
        .eq("pedido_id", job.pedido_id)
        .eq("produto_id", item.produto_id);

      processed++;

      logger.info("worker", `Saída lançada: ${item.sku} x${item.quantidade_pedida} de ${empresaEscolhida.empresaNome}`, {
        pedidoId: job.pedido_id,
        sku: item.sku,
        quantidade: item.quantidade_pedida,
        empresaId: empresaEscolhida.empresaId,
      });

      await sleep(500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors++;
      failedSkus.push(item.sku);
      logger.logError({
        error: err,
        source: "worker",
        message: `Falha ao lançar saída: ${item.sku}`,
        category: "external_api",
        pedidoId: job.pedido_id,
        empresaId: empresaEscolhida.empresaId,
        empresaNome: empresaEscolhida.empresaNome,
        metadata: { sku: item.sku, operation: "movimentarEstoque", depositoId },
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
    empresaId: empresaEscolhida.empresaId,
    empresaNome: empresaEscolhida.empresaNome,
    totalItens: itens.length,
    processed,
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
