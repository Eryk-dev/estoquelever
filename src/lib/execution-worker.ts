/**
 * Execution worker — processes the siso_fila_execucao queue.
 *
 * Picks pending jobs one at a time, respects Tiny API rate limits,
 * and retries with exponential backoff on failure.
 *
 * Stock posting flow (per decisao):
 * - ALL: insert marcadores on Tiny order
 * - "propria": marcadores → gerar NF → lançar estoque da NF → fase-1 agrupamento
 * - "transferencia": marcadores → gerar NF on origin → lançar estoque NF (clears reservation)
 *     → movimentarEstoque(E) on origin per item (compensates saldo)
 *     → movimentarEstoque(S) on support empresa per item (physical exit) → fase-1 agrupamento
 * - "oc": marcadores → gerar NF (sem estoque) → fase-1 agrupamento → resolver itens de compra
 *     Stock deduction for OC is deferred to Ciclo 2 (worker after compras-release).
 *
 * NF timing: propria/transferencia generate NF at approval (existing behavior).
 * OC now also generates NF at approval time, creating a Tiny reservation without
 * deducting saldo. The Ciclo 2 worker detects the existing NF via gerarNotaFiscalPedido
 * idempotency and skips directly to stock deduction.
 *
 * Agrupamento timing: fase-1 agrupamento is attempted as soon as NF persistence
 * is complete (nota_fiscal_id + chave_acesso_nf), across all three decisoes.
 * Agrupamento failure is always isolated from stock posting — it never causes
 * the worker job to fail or retry after stock has been persisted.
 */

import { createServiceClient } from "./supabase-server";
import {
  criarMarcadoresPedido,
  gerarNotaFiscal,
  lancarEstoqueNota,
  movimentarEstoque,
  buscarProdutoPorSku,
  obterNotaFiscal,
} from "./tiny-api";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { getOrdemDeducao } from "./grupo-resolver";
import { getEmpresaById } from "./empresa-lookup";
import { logger } from "./logger";
import { criarAgrupamentoFase1 } from "./agrupamento-service";
import { getFornecedorBySku } from "./sku-fornecedor";

// ─── Shared: enrich NF data + transition if already authorized ──────────────
// After NF generation, checks Tiny API for authorization status.
// If situacao is 6 (Autorizada) or 7 (Emitida Danfe), transitions immediately.
// Otherwise saves chave_acesso_nf if available and lets the webhook handle transition.

async function enriquecerDadosNf(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  empresaId: string,
  notaId: number | null,
): Promise<void> {
  if (!notaId) return;

  try {
    const { token } = await getValidTokenByEmpresa(empresaId);
    const nfData = await runWithEmpresa(empresaId, () =>
      obterNotaFiscal(token, notaId),
    );

    const NF_AUTORIZADA = [6, 7]; // 6=Autorizada, 7=Emitida Danfe
    const autorizada = NF_AUTORIZADA.includes(Number(nfData.situacao));

    if (nfData.chaveAcesso) {
      // Save chave_acesso_nf but do NOT transition status.
      // Transition aguardando_nf → aguardando_separacao happens ONLY via NF webhook.
      await supabase
        .from("siso_pedidos")
        .update({ chave_acesso_nf: nfData.chaveAcesso })
        .eq("id", pedidoId);

      logger.info("worker", "chave_acesso_nf salva (transição via webhook)", {
        pedidoId,
        notaId,
        situacao: nfData.situacao,
      });
    }
  } catch {
    // Non-critical — webhook or reconciliation will handle later
  }
}

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
    .order("prioridade", { ascending: false })
    .order("criado_em", { ascending: true })
    .limit(limit);

  if (error || !jobs?.length) {
    return result;
  }

  for (const job of jobs as FilaJob[]) {
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
  if (job.tipo === "lancar_estoque") {
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
    return;
  }

  if (job.tipo === "lancar_estoque_pos_nf") {
    if (job.decisao === "propria") {
      await executarEstoquePosNfPropria(job);
      return;
    }
    if (job.decisao === "transferencia") {
      await executarEstoquePosNfTransferencia(job);
      return;
    }
    logger.warn("worker", `Decisão não suportada para lancar_estoque_pos_nf: ${job.decisao}`, {
      pedidoId: job.pedido_id,
      decisao: job.decisao,
    });
    return;
  }

  throw new Error(`Tipo de job desconhecido: ${job.tipo}`);
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
    await runWithEmpresa(empresaId, () =>
      criarMarcadoresPedido(token, pedidoId, marcadores),
    );
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
    const nota = await runWithEmpresa(empresaId, () =>
      gerarNotaFiscal(token, pedidoId),
    );

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
    await enriquecerDadosNf(supabase, job.pedido_id, job.empresa_id, null);
    logger.warn("worker", "NF externa — aguardando webhook para lançar estoque", {
      pedidoId: job.pedido_id,
    });
    return;
  }

  // Save chave_acesso_nf if available, but do NOT post stock or transition status.
  // Stock posting (lancarEstoqueNota) and transition happen ONLY via NF webhook.
  await enriquecerDadosNf(supabase, job.pedido_id, job.empresa_id, notaId);

  logger.info("worker", "NF gerada, aguardando webhook para lançar estoque (própria)", {
    pedidoId: job.pedido_id,
    notaId,
    empresaId: job.empresa_id,
  });
}

// ─── oc: only insert marcadores, no NF or stock ─────────────────────────────

async function resolveCompraItemIds(
  pedidoId: string,
  empresaOrigemId: string | null | undefined,
): Promise<Array<{ id: string; quantidadeSolicitada: number; sku: string }>> {
  const supabase = createServiceClient();

  const { data: items, error: itemsError } = await supabase
    .from("siso_pedido_itens")
    .select("id, produto_id, quantidade_pedida, sku")
    .eq("pedido_id", pedidoId);

  if (itemsError || !items) {
    throw new Error(
      `Nao foi possivel resolver itens do pedido para compra: ${itemsError?.message ?? "not found"}`,
    );
  }

  if (items.length === 0) return [];

  if (!empresaOrigemId) {
    logger.warn(
      "execution-worker",
      "Pedido OC sem empresa de origem para calcular faltas; usando quantidade integral",
      {
        pedidoId,
      },
    );
    return items.map((item) => ({
      id: String(item.id),
      quantidadeSolicitada: Number(item.quantidade_pedida ?? 0),
      sku: String(item.sku ?? ""),
    }));
  }

  const { data: estoques, error: estoqueError } = await supabase
    .from("siso_pedido_item_estoques")
    .select("produto_id, disponivel")
    .eq("pedido_id", pedidoId)
    .eq("empresa_id", empresaOrigemId);

  if (estoqueError) {
    logger.warn(
      "execution-worker",
      "Nao foi possivel consultar estoque da empresa de origem para compra",
      {
        pedidoId,
        empresaOrigemId,
        error: estoqueError.message,
      },
    );
    return items.map((item) => ({
      id: String(item.id),
      quantidadeSolicitada: Number(item.quantidade_pedida ?? 0),
      sku: String(item.sku ?? ""),
    }));
  }

  const disponivelPorProduto = new Map<string, number>();
  for (const estoque of estoques ?? []) {
    disponivelPorProduto.set(
      String(estoque.produto_id),
      Number(estoque.disponivel ?? 0),
    );
  }

  // Allocate the available stock across repeated products before deciding the
  // missing quantity to buy for each order line.
  const demandas: Array<{ id: string; quantidadeSolicitada: number; sku: string }> = [];

  for (const item of [...items].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  )) {
    const quantidadePedida = Number(item.quantidade_pedida ?? 0);
    const produtoId = String(item.produto_id);
    const disponivelAtual = Math.max(disponivelPorProduto.get(produtoId) ?? 0, 0);
    const quantidadeCoberta = Math.min(disponivelAtual, quantidadePedida);
    const quantidadeFaltante = Math.max(quantidadePedida - quantidadeCoberta, 0);

    disponivelPorProduto.set(
      produtoId,
      Math.max(disponivelAtual - quantidadePedida, 0),
    );

    if (quantidadeFaltante > 0) {
      demandas.push({
        id: String(item.id),
        quantidadeSolicitada: quantidadeFaltante,
        sku: String(item.sku ?? ""),
      });
    }
  }

  return demandas;
}

async function executarMarcadoresOnly(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  const { data: pedido } = await supabase
    .from("siso_pedidos")
    .select("marcadores, empresa_origem_id, nota_fiscal_id")
    .eq("id", job.pedido_id)
    .single();

  const { token } = await getValidTokenByEmpresa(job.empresa_id);
  const marcadores: string[] = pedido?.marcadores ?? [];

  await inserirMarcadoresTiny(job.empresa_id, token, job.pedido_id, marcadores);

  // ── NF generation + agrupamento for OC ──────────────────────────────────────
  // OC now generates NF at approval time (creates Tiny reservation without
  // deducting saldo). Failure-isolated: NF/agrupamento failure does NOT block
  // compra item resolution below. Stock deduction remains deferred to Ciclo 2.
  // enriquecerDadosNf won't trigger status_separacao transition because the
  // pedido is not in aguardando_nf state at this point.
  let nfGerada = !!(pedido?.nota_fiscal_id);
  try {
    const notaId = await gerarNotaFiscalPedido(
      job.empresa_id,
      token,
      job.pedido_id,
      pedido?.nota_fiscal_id ?? null,
    );
    if (notaId) {
      nfGerada = true;
      await enriquecerDadosNf(supabase, job.pedido_id, job.empresa_id, notaId);
      // Fase-1 agrupamento — fire-and-forget, never throws.
      // If chave_acesso_nf is not yet available (NF pending SEFAZ authorization),
      // criarAgrupamentoFase1 will skip and leave for second-chance entrypoints.
      await criarAgrupamentoFase1(job.pedido_id);
    }
  } catch (err) {
    // NF/agrupamento failure does not block compra item resolution
    logger.warn("worker", "Falha na geração de NF/agrupamento para OC (prosseguindo com compra)", {
      pedidoId: job.pedido_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Resolve compra items ────────────────────────────────────────────────────
  const compraDemandas = await resolveCompraItemIds(
    job.pedido_id,
    pedido?.empresa_origem_id ?? job.empresa_id,
  );

  if (compraDemandas.length === 0) {
    const now = new Date().toISOString();

    await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: null,
        ordem_compra_id: null,
        compra_quantidade_solicitada: 0,
        compra_solicitada_em: null,
      })
      .eq("pedido_id", job.pedido_id);

    // Always start at aguardando_nf — transition to aguardando_separacao
    // happens ONLY via NF webhook, even if NF was already generated.
    const statusSeparacao = "aguardando_nf";

    await supabase
      .from("siso_pedidos")
      .update({
        decisao_final: "propria",
        status: "executando",
        status_separacao: statusSeparacao,
      })
      .eq("id", job.pedido_id);

    const { data: existingReleaseJob } = await supabase
      .from("siso_fila_execucao")
      .select("id")
      .eq("pedido_id", job.pedido_id)
      .eq("tipo", "lancar_estoque")
      .in("status", ["pendente", "executando"])
      .maybeSingle();

    if (!existingReleaseJob) {
      await supabase
        .from("siso_fila_execucao")
        .insert({
          pedido_id: job.pedido_id,
          tipo: "lancar_estoque",
          empresa_id: pedido?.empresa_origem_id ?? job.empresa_id,
          decisao: "propria",
          atualizado_em: now,
        });
    }

    logger.info(
      "execution-worker",
      "Pedido OC sem faltas reais; liberado direto para fluxo proprio",
      {
        pedidoId: job.pedido_id,
        empresaOrigemId: pedido?.empresa_origem_id ?? job.empresa_id,
        nfGerada,
        statusSeparacao,
      },
    );
    return;
  }

  const now = new Date().toISOString();

  await supabase
    .from("siso_pedidos")
    .update({ status_separacao: "validacao_oc" })
    .eq("id", job.pedido_id);

  for (const demanda of compraDemandas) {
    await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "oc_pendente",
        compra_quantidade_solicitada: demanda.quantidadeSolicitada,
        compra_solicitada_em: now,
        fornecedor_oc: getFornecedorBySku(demanda.sku).fornecedor,
      })
      .eq("id", demanda.id);
  }

  logger.info("execution-worker", "Pedido OC enviado para modulo de compras", {
    pedidoId: job.pedido_id,
    itensCompra: compraDemandas.length,
    nfGerada,
    quantidadeSolicitadaTotal: compraDemandas.reduce(
      (sum, demanda) => sum + demanda.quantidadeSolicitada,
      0,
    ),
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

  const notaIdOrigem = await gerarNotaFiscalPedido(
    pedido.empresa_origem_id,
    origemToken,
    job.pedido_id,
    pedido.nota_fiscal_id ?? null,
  );
  await sleep(500);

  // Save chave_acesso_nf if available, but do NOT post stock or transition status.
  // All stock operations (lancarEstoqueNota + movimentarEstoque compensações + saídas)
  // happen ONLY after NF authorization via webhook → lancar_estoque_pos_nf job.
  if (notaIdOrigem) {
    await enriquecerDadosNf(supabase, job.pedido_id, pedido.empresa_origem_id, notaIdOrigem);
  }

  // Check if NF is already authorized (re-approval after encaminhar, or fast SEFAZ).
  // In this case the NF webhook won't re-trigger (dedup), so we create the
  // lancar_estoque_pos_nf job directly.
  const { data: pedidoCheck } = await supabase
    .from("siso_pedidos")
    .select("chave_acesso_nf, status_separacao")
    .eq("id", job.pedido_id)
    .single();

  if (pedidoCheck?.chave_acesso_nf) {
    const { error: insertErr } = await supabase.from("siso_fila_execucao").insert({
      pedido_id: job.pedido_id,
      tipo: "lancar_estoque_pos_nf",
      empresa_id: job.empresa_id,
      decisao: job.decisao,
      atualizado_em: new Date().toISOString(),
    });

    if (!insertErr) {
      logger.info("worker", "NF já autorizada — job lancar_estoque_pos_nf criado direto", {
        pedidoId: job.pedido_id,
        empresaId: job.empresa_id,
      });
      kickWorker().catch(() => {});
    } else {
      logger.warn("worker", "Falha ao criar job lancar_estoque_pos_nf direto", {
        pedidoId: job.pedido_id,
        error: insertErr.message,
      });
    }
  } else {
    logger.info("worker", "NF gerada, aguardando webhook para lançar estoque (transferência)", {
      pedidoId: job.pedido_id,
      notaIdOrigem,
      empresaOrigemId: pedido.empresa_origem_id,
    });
  }
}

// ─── Post-NF stock posting (triggered by NF webhook via lancar_estoque_pos_nf job) ──

async function executarEstoquePosNfPropria(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  const { data: pedido, error: pedidoErr } = await supabase
    .from("siso_pedidos")
    .select("nota_fiscal_id, estoque_lancado")
    .eq("id", job.pedido_id)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error(`Pedido ${job.pedido_id} não encontrado`);
  }

  if (pedido.estoque_lancado) {
    logger.info("worker", "Estoque já lançado (retry idempotente)", { pedidoId: job.pedido_id });
    return;
  }

  const notaId = pedido.nota_fiscal_id;
  if (!notaId) {
    throw new Error(`Pedido ${job.pedido_id} sem nota_fiscal_id — impossível lançar estoque`);
  }

  const { token } = await getValidTokenByEmpresa(job.empresa_id);

  await runWithEmpresa(job.empresa_id, () =>
    lancarEstoqueNota(token, notaId),
  );

  await supabase
    .from("siso_pedidos")
    .update({ estoque_lancado: true })
    .eq("id", job.pedido_id);

  logger.info("worker", "Estoque lançado via NF pós-autorização (própria)", {
    pedidoId: job.pedido_id,
    notaId,
    empresaId: job.empresa_id,
  });
}

async function executarEstoquePosNfTransferencia(job: FilaJob): Promise<void> {
  const supabase = createServiceClient();

  const { data: pedido, error: pedidoErr } = await supabase
    .from("siso_pedidos")
    .select("numero, nota_fiscal_id, estoque_lancado, nf_estoque_lancado, empresa_origem_id, marcadores")
    .eq("id", job.pedido_id)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error(`Pedido ${job.pedido_id} não encontrado`);
  }

  if (pedido.estoque_lancado) {
    logger.info("worker", "Estoque já lançado (retry idempotente)", { pedidoId: job.pedido_id });
    return;
  }

  const empresaOrigem = await getEmpresaById(pedido.empresa_origem_id);
  if (!empresaOrigem) {
    throw new Error(`Empresa origem ${pedido.empresa_origem_id} não encontrada`);
  }

  const notaIdOrigem = pedido.nota_fiscal_id;

  // 1. Post stock from NF + compensating entries on origin (one-time, permanent).
  // nf_estoque_lancado tracks whether this was already done — encaminhar preserves it.
  // On re-execution after encaminhar, we skip straight to the exit from support.
  const precisaLancarNf = !pedido.nf_estoque_lancado;

  if (precisaLancarNf && notaIdOrigem) {
    const { token: origemToken } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
    await runWithEmpresa(pedido.empresa_origem_id, () =>
      lancarEstoqueNota(origemToken, notaIdOrigem),
    );
    logger.info("worker", "Estoque da NF lançado na origem (limpa reserva)", {
      pedidoId: job.pedido_id,
      notaId: notaIdOrigem,
      empresaOrigemId: pedido.empresa_origem_id,
    });
    await sleep(500);
  } else if (!precisaLancarNf) {
    logger.info("worker", "NF já lançada anteriormente (nf_estoque_lancado=true) — só saída", {
      pedidoId: job.pedido_id,
    });
  }

  // 2. Get origin empresa deposit for compensating entries
  const { token: origemToken } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
  const { data: connOrigem } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("empresa_id", pedido.empresa_origem_id)
    .eq("ativo", true)
    .single();
  const depositoIdOrigem = connOrigem?.deposito_id ?? null;

  // 3. Stock deduction: find ONE empresa that covers 100% of items
  const { data: itens, error: itensErr } = await supabase
    .from("siso_pedido_itens")
    .select("produto_id, sku, descricao, quantidade_pedida, estoque_saida_lancada")
    .eq("pedido_id", job.pedido_id)
    .or("estoque_saida_lancada.is.null,estoque_saida_lancada.eq.false");

  if (itensErr) {
    throw new Error(`Erro ao buscar itens: ${itensErr.message}`);
  }

  if (!itens?.length) {
    logger.info("worker", "Todos os itens já tiveram saída lançada", { pedidoId: job.pedido_id });
    await supabase.from("siso_pedidos").update({ estoque_lancado: true }).eq("id", job.pedido_id);
    return;
  }

  const { data: estoques } = await supabase
    .from("siso_pedido_item_estoques")
    .select("produto_id, empresa_id, disponivel, produto_id_na_empresa")
    .eq("pedido_id", job.pedido_id);

  const empresaSuporte = await getEmpresaById(job.empresa_id);
  if (!empresaSuporte || !empresaSuporte.grupoId) {
    throw new Error(`Empresa suporte ${job.empresa_id} sem grupo — não é possível transferir`);
  }

  const ordemDeducao = await getOrdemDeducao(empresaSuporte.grupoId, job.empresa_id);
  const empresasDeducao = ordemDeducao.filter((e) => e.galpaoId !== empresaOrigem.galpaoId);

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

  // 4. Deduct all items from the chosen empresa
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
      const cachedEst = estoques?.find(
        (e) => e.empresa_id === empresaEscolhida!.empresaId && e.produto_id === item.produto_id,
      );
      let produtoIdNaEmpresa = cachedEst?.produto_id_na_empresa as number | null;

      if (!produtoIdNaEmpresa) {
        const produto = await runWithEmpresa(empresaEscolhida.empresaId, () =>
          buscarProdutoPorSku(suporteToken, item.sku),
        );
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
        produtoIdNaEmpresa = produto.id;
        await sleep(500);
      }

      // Compensate saldo on origin: lancarEstoqueNota dropped saldo on origin,
      // but the physical stock didn't leave origin — add it back.
      // Only compensate on the first round (precisaLancarNf). On re-execution
      // after encaminhar, the NF was already posted and compensated — doing it
      // again would create a phantom +1 on origin.
      if (notaIdOrigem && precisaLancarNf) {
        const produtoIdOrigem = item.produto_id as number;
        try {
          await runWithEmpresa(pedido.empresa_origem_id, () =>
            movimentarEstoque(origemToken, produtoIdOrigem, {
              tipo: "E",
              quantidade: item.quantidade_pedida as number,
              deposito: depositoIdOrigem ? { id: depositoIdOrigem } : undefined,
              observacoes: `Compensação: transferência pedido ${pedido.numero} atendido por ${empresaEscolhida!.empresaNome}`,
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("worker", `Falha na entrada compensatória na origem: ${item.sku}`, {
            pedidoId: job.pedido_id,
            sku: item.sku,
            error: msg,
          });
        }
        await sleep(500);
      }

      // Deduct stock from support empresa (physical exit)
      await runWithEmpresa(empresaEscolhida.empresaId, () =>
        movimentarEstoque(suporteToken, produtoIdNaEmpresa!, {
          tipo: "S",
          quantidade: item.quantidade_pedida as number,
          deposito: depositoId ? { id: depositoId } : undefined,
          observacoes,
        }),
      );

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

  await supabase
    .from("siso_pedidos")
    .update({ estoque_lancado: true, nf_estoque_lancado: true })
    .eq("id", job.pedido_id);

  logger.info("worker", "Estoque lançado pós-NF (transferência)", {
    pedidoId: job.pedido_id,
    notaIdOrigem,
    nfLancadaPrimeiraVez: precisaLancarNf,
    empresaId: empresaEscolhida.empresaId,
    empresaNome: empresaEscolhida.empresaNome,
    totalItens: itens.length,
    processed,
  });
}

// ─── Singleton drain loop ────────────────────────────────────────────────────
// Ensures only one processQueue loop runs at a time. When kicked, it drains
// the entire pending queue in batches. Concurrent kicks are no-ops (the
// running loop will pick up newly inserted jobs).

let _draining = false;

export async function kickWorker(): Promise<void> {
  if (_draining) return;
  _draining = true;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await processQueue(5);
      if (result.processed === 0 && result.errors === 0) break;
      await sleep(500);
    }
  } catch (err) {
    logger.error("worker", "Drain loop error", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    _draining = false;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
