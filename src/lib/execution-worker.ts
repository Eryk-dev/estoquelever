/**
 * Execution worker — processes the siso_fila_execucao queue.
 *
 * Picks pending jobs one at a time, respects Tiny API rate limits,
 * and retries with exponential backoff on failure.
 *
 * Estoque é fonte única WMS: a baixa física vive no ledger (siso_movimentacoes),
 * não no Tiny. O worker cuida da camada fiscal (marcadores + NF) e dispara o
 * cutover R→L+S no ledger; a saída pós-NF é delegada a executarEstoquePosNfWms.
 *
 * Stock posting flow (per decisao):
 * - ALL: insert marcadores on Tiny order (camada fiscal)
 * - "propria": marcadores → gerar NF → cutover R→L+S no ledger WMS
 *     (dispararCutoverSePronto / executarEstoquePosNfWms) → fase-1 agrupamento
 * - "transferencia": marcadores → gerar NF on origin → cutover R→L+S no
 *     ledger WMS → fase-1 agrupamento
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
  obterNotaFiscal,
} from "./tiny-api";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { getEmpresaById } from "./empresa-lookup";
import { logger } from "./logger";
import { criarAgrupamentoFase1 } from "./agrupamento-service";
import { getFornecedorBySku } from "./sku-fornecedor";
import { executarEstoquePosNfWms } from "./execution-worker-wms";
import { dispararCutoverSePronto } from "./wms/cutover";
import { resolverProdutoWms } from "./separacao/wms-mapping";
import { backoffManutencao } from "./wms/jobs-manutencao";

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

    // Só persistir chave_acesso_nf quando a NF está AUTORIZADA. Uma NF
    // rejeitada (5)/pendente (1)/aguardando recibo (4/9) já carrega chaveAcesso
    // (a chave é calculada na emissão, antes do retorno do SEFAZ), mas NÃO é
    // fiscal válida. Salvá-la fazia o pedido PARECER ter NF autorizada e ser
    // empurrado pra separação — pedidos OC com NF rejeitada apareciam pra
    // separar (bug 2026-06-15). A transição de status segue só via NF webhook,
    // que também só avança quando autorizada.
    if (autorizada && nfData.chaveAcesso) {
      await supabase
        .from("siso_pedidos")
        .update({ chave_acesso_nf: nfData.chaveAcesso })
        .eq("id", pedidoId);

      logger.info("worker", "chave_acesso_nf salva (NF autorizada; transição via webhook)", {
        pedidoId,
        notaId,
        situacao: nfData.situacao,
      });
    } else if (!autorizada) {
      logger.info("worker", "NF ainda não autorizada — chave_acesso_nf NÃO salva", {
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
  payload?: ({
    itens_ja_lancados?: number[];
  } & Record<string, unknown>) | null;
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

  // P145: reclaim de jobs estagnados. Um job que ficou 'executando' (worker
  // crashou, deploy no meio, exceção fora do try) nunca volta a ser selecionado
  // porque o SELECT abaixo filtra só 'pendente'. Aqui devolvemos pra 'pendente'
  // qualquer job 'executando' cujo atualizado_em (marca de início, escrita no
  // claim) seja mais antigo que 5min. Reprocessar é seguro: executeJob é
  // idempotente por reserva (estorno_de) e por estoque_lancado.
  const cincoMinAtras = new Date(Date.now() - 5 * 60_000).toISOString();
  await supabase
    .from("siso_fila_execucao")
    .update({ status: "pendente", proximo_retry_em: now, atualizado_em: now })
    .eq("status", "executando")
    .lt("atualizado_em", cincoMinAtras);

  // Claim em duas fases: jobs de pedido (lancar_estoque*) SEMPRE antes dos de
  // manutenção (varredura/reconciliar). Sem isso, um flood de varreduras (ex:
  // snapshot inicial = ~900 jobs) segura pedidos novos atrás da fila por horas.
  const PEDIDO_TIPOS = ["lancar_estoque", "lancar_estoque_pos_nf"];
  const selectCols =
    "id, pedido_id, tipo, empresa_id, decisao, tentativas, max_tentativas, payload";

  const { data: pedidoJobs, error } = await supabase
    .from("siso_fila_execucao")
    .select(selectCols)
    .eq("status", "pendente")
    .or(`proximo_retry_em.is.null,proximo_retry_em.lte.${now}`)
    .in("tipo", PEDIDO_TIPOS)
    .order("prioridade", { ascending: false })
    .order("criado_em", { ascending: true })
    .limit(limit);

  if (error) {
    return result;
  }

  let jobs = pedidoJobs ?? [];

  if (jobs.length < limit) {
    const { data: maintJobs } = await supabase
      .from("siso_fila_execucao")
      .select(selectCols)
      .eq("status", "pendente")
      .or(`proximo_retry_em.is.null,proximo_retry_em.lte.${now}`)
      .not("tipo", "in", `(${PEDIDO_TIPOS.join(",")})`)
      .order("prioridade", { ascending: false })
      .order("criado_em", { ascending: true })
      .limit(limit - jobs.length);

    jobs = jobs.concat(maintJobs ?? []);
  }

  if (!jobs.length) {
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

      // Jobs de manutenção (varredura/reconciliar) não têm pedido real próprio —
      // o pedido_id é sentinela ('MAINT') ou aponta pro pedido afetado. NÃO flipar
      // status='concluido' (concluiria o pedido errado / no estado errado).
      if (
        job.tipo === "lancar_estoque" ||
        job.tipo === "lancar_estoque_pos_nf"
      ) {
        await supabase
          .from("siso_pedidos")
          .update({
            status: "concluido",
            processado_em: new Date().toISOString(),
          })
          .eq("id", job.pedido_id)
          .eq("status", "executando");
      }

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

      // Jobs de manutenção usam backoff custom 30s/5min/10min (nota P082) —
      // varredura/reconciliação não são tão urgentes quanto o lançamento fiscal,
      // e não devem martelar o banco. Os jobs fiscais mantêm o exponencial.
      const ehManutencao =
        job.tipo === "varredura_pos_entrada" ||
        job.tipo === "reconciliar_oc_retry";
      const retryDelay = ehManutencao
        ? backoffManutencao(tentativas)
        : Math.min(30_000 * Math.pow(2, tentativas - 1), 120_000);

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

  if (job.tipo === "varredura_pos_entrada") {
    const { varrerPedidosAfetadosPorEntrada } = await import("./wms/varredura-validacao-oc");
    const { reconciliarEntradaEstoque } = await import("./wms/reconciliador-oc");
    const p = (job.payload ?? {}) as { produto_id: string; galpao_id: string; localizacao_id?: string };
    await varrerPedidosAfetadosPorEntrada({
      produto_id: p.produto_id, galpao_id: p.galpao_id, localizacao_id: p.localizacao_id ?? "",
    });
    await reconciliarEntradaEstoque({ produtoId: p.produto_id, galpaoId: p.galpao_id });
    return;
  }
  if (job.tipo === "reconciliar_oc_retry") {
    const { reconciliarEntradaEstoque } = await import("./wms/reconciliador-oc");
    const p = (job.payload ?? {}) as { produto_id: string; galpao_id: string };
    await reconciliarEntradaEstoque({ produtoId: p.produto_id, galpaoId: p.galpao_id });
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
  // "LVR" é enviado ao Tiny no webhook-processor (fire-and-forget) para todo pedido
  // assim que recebido. Filtrar aqui evita erro de duplicação no POST batch.
  const paraEnviar = marcadores.filter((m) => m !== "LVR");
  if (paraEnviar.length === 0) return;

  try {
    await runWithEmpresa(empresaId, () =>
      criarMarcadoresPedido(token, pedidoId, paraEnviar),
    );
    logger.info("worker", "Marcadores inseridos no pedido Tiny", {
      pedidoId,
      marcadores: paraEnviar,
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

  // Save chave_acesso_nf if available, but do NOT transition status here.
  // A baixa no ledger WMS é disparada pelo cutover abaixo.
  await enriquecerDadosNf(supabase, job.pedido_id, job.empresa_id, notaId);

  // Cutover R→L+S acontece quando o pedido atinge status forward
  // (separado/embalado/expedido) COM NF emitida. Aqui a NF acabou de ser
  // gerada — se o pedido já estava em status forward (ex: fluxo concluir-oc
  // que vira separado ANTES de gerar NF), o helper dispara agora. Caso normal
  // (status=aguardando_separacao), o helper guarda — o /concluir vai disparar.
  const result = await dispararCutoverSePronto(job.pedido_id);
  logger.info("worker", "dispararCutoverSePronto pós-NF (propria)", {
    pedidoId: job.pedido_id,
    enqueued: result.enqueued,
    motivo: result.motivo,
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

  // (Fase 1.4 — 2026-05-28) Lê disponível VIVO de siso_estoque, não o snapshot
  // estale siso_pedido_item_estoques. O snapshot congelava o saldo do momento do
  // webhook; quando outro pedido consumia ou a loc zerava, a decisão de OC saía
  // errada → loop (pedido 937933727). Resolve produto WMS por (empresa,
  // tiny_produto_id) e soma disponível ao longo de todos os galpões.
  const tinyIds = [...new Set(items.map((i) => String(i.produto_id)))];
  const produtoWmsByTiny = new Map<string, string>();
  for (const tinyId of tinyIds) {
    try {
      const wms = await resolverProdutoWms(empresaOrigemId, tinyId);
      produtoWmsByTiny.set(tinyId, wms);
    } catch {
      // Sem mapeamento em siso_produto_empresas → trata como disponível 0
      // (compra a qty integral). Não bloqueia o fluxo de compra.
    }
  }

  const disponivelPorWms = new Map<string, number>();
  const wmsIds = [...new Set(produtoWmsByTiny.values())];
  if (wmsIds.length > 0) {
    const { data: estoqueVivo, error: estoqueError } = await supabase
      .from("siso_estoque")
      .select("produto_id, disponivel")
      .in("produto_id", wmsIds);
    if (estoqueError) {
      logger.warn("execution-worker", "Falha ao consultar siso_estoque vivo para compra", {
        pedidoId,
        empresaOrigemId,
        error: estoqueError.message,
      });
      return items.map((item) => ({
        id: String(item.id),
        quantidadeSolicitada: Number(item.quantidade_pedida ?? 0),
        sku: String(item.sku ?? ""),
      }));
    }
    for (const e of estoqueVivo ?? []) {
      disponivelPorWms.set(
        String(e.produto_id),
        (disponivelPorWms.get(String(e.produto_id)) ?? 0) + Number(e.disponivel ?? 0),
      );
    }
  }

  // Reindexa disponível por tiny_produto_id (chave usada na alocação abaixo).
  const disponivelPorProduto = new Map<string, number>();
  for (const [tinyId, wms] of produtoWmsByTiny) {
    disponivelPorProduto.set(tinyId, disponivelPorWms.get(wms) ?? 0);
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

  // Save chave_acesso_nf if available, but do NOT transition status here.
  // A baixa no ledger WMS acontece após autorização da NF via webhook →
  // job lancar_estoque_pos_nf → executarEstoquePosNfWms (cutover R→L+S).
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
    // helper decide se dispara (depende de status forward + estoque_lancado)
    const result = await dispararCutoverSePronto(job.pedido_id);
    logger.info("worker", "dispararCutoverSePronto pós-NF (transferencia)", {
      pedidoId: job.pedido_id,
      enqueued: result.enqueued,
      motivo: result.motivo,
    });
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
  return executarEstoquePosNfWms({
    pedido_id: job.pedido_id,
    empresa_id: job.empresa_id,
    decisao: job.decisao,
  });
}

async function executarEstoquePosNfTransferencia(job: FilaJob): Promise<void> {
  return executarEstoquePosNfWms({
    pedido_id: job.pedido_id,
    empresa_id: job.empresa_id,
    decisao: job.decisao,
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
