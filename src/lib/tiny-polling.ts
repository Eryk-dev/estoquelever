/**
 * Polling fallback Tiny → SISO.
 *
 * O fluxo primário é o webhook (api/wms/webhook/tiny). Webhooks podem ser
 * perdidos (downtime do deploy, falha de entrega do Tiny, timeout). Este
 * módulo varre periodicamente TODAS as contas Tiny conectadas e reprocessa
 * o que escapou, com janela máxima de 7 dias pra trás (não puxa pedidos
 * antigos):
 *
 *   - Webhooks de aprovação ENTREGUES cujo processamento falhou ou morreu
 *     no meio → re-tenta reutilizando o próprio log (retryWebhooksFalhos;
 *     independe da listagem do Tiny, cobre pedido de qualquer idade).
 *   - Pedidos APROVADOS (situacao=3) que não existem em siso_pedidos nem
 *     em siso_webhook_logs → mesmos efeitos do webhook (processWebhook).
 *     Janela própria de 30d (a listagem filtra por data de CRIAÇÃO).
 *   - Pedidos CANCELADOS (situacao=2) no Tiny mas ainda ativos no SISO →
 *     mesma lógica do webhook (handlePedidoCancelamento).
 *   - NFs AUTORIZADAS (situacao=6) e EMITIDA DANFE (7 — NF autorizada cuja
 *     DANFE já saiu entre um poll e outro) → handleNfWebhook (dedup interno;
 *     log em 'aguardando_pedido' re-entrega pro retry de match do handler).
 *   - Pedidos PRESOS em aguardando_nf com NF completa (id + chave) há >30min
 *     → transiciona pra aguardando_separacao + fase-1 do agrupamento
 *     (recuperarNfsPresas; cobre transição perdida/regressão de status).
 *
 * Dedup: o poller insere em siso_webhook_logs com tipo='polling_pedido' —
 * o dedup_key generated (tiny_pedido_id:tipo:codigo_situacao) torna cada
 * varredura idempotente ENTRE POLLS. Ele NÃO colide com logs de webhook real
 * (tipo diferente ⇒ dedup_key diferente), então a corrida poll × webhook
 * atrasado é mitigada por um re-check por item imediatamente antes do
 * processamento (encolhe a janela pra sub-segundo — mesma classe de corrida
 * pré-existente entre inclusao_pedido e atualizacao_pedido).
 *
 * Retry: logs com status='erro' ou presos em 'processando'/'recebido' por
 * >1h (função serverless morta no meio) NÃO bloqueiam o dedup — a próxima
 * varredura re-tenta, independente do tipo (webhook real ou poller). Só
 * 'concluido'/'ignorado' e logs frescos em andamento bloqueiam. Antes,
 * logs de webhook real bloqueavam pra sempre → 22 vendas EasyPeasy
 * perdidas em 2026-06-11 quando a conexão Tiny caiu e o processamento
 * morreu sem marcar erro. /webhook/reprocessar segue disponível pra
 * forçar reprocesso manual pontual.
 */

import { createServiceClient } from "./supabase-server";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import {
  listarPedidos,
  listarNotas,
  type TinyPedidoListItem,
  type TinyNotaListItem,
} from "./tiny-api";
import { getEmpresaByCnpj, type EmpresaInfo } from "./empresa-lookup";
import { processWebhook } from "./webhook-processor";
import { handleNfWebhook, type NfWebhookPayload } from "./nf-webhook-handler";
import { handlePedidoCancelamento } from "./pedido-cancel-handler";
import { criarAgrupamentoFase1 } from "./agrupamento-service";
import { logger } from "./logger";

const LOG_SOURCE = "tiny-polling";
const DIAS_JANELA = 7;
// Aprovados: janela maior — a listagem do Tiny filtra por data de CRIAÇÃO,
// e pedido criado semanas atrás pode ser aprovado só agora (incidente
// 2026-06-12: pedidos de 21/05 aprovados em 11/06, invisíveis aos 7d).
const DIAS_JANELA_APROVADOS = 30;
const PAGE_LIMIT = 100;
// Backstop contra paginação infinita (7d × ~500 pedidos/dia << 30 páginas)
const MAX_PAGES = 30;

const SITUACAO_PEDIDO_APROVADA = 3;
const SITUACAO_PEDIDO_CANCELADA = 2;
const SITUACOES_NF = [6, 7]; // 6=Autorizada, 7=Emitida Danfe

// Log 'processando' mais velho que isso = run morto (maxDuration) → retry
const STUCK_PROCESSANDO_MS = 60 * 60 * 1000;

// Retry de webhooks falhos: cap por empresa por run (protege o rate-limit;
// backlog drena em runs sucessivos do cron de 10min).
const RETRY_FALHOS_MAX = 20;
// Não re-tenta logs mais velhos que isso: a situação no Tiny pode ter mudado
// faz tempo (faturado/cancelado manualmente) e o reprocesso cego recriaria
// um pedido já tratado fora do SISO.
const RETRY_FALHOS_JANELA_MS = 7 * 24 * 60 * 60 * 1000;

// NF presa: pedido com NF completa (id + chave) parado em aguardando_nf há
// mais que isso = a transição pra aguardando_separacao se perdeu (ex.:
// reprocesso tardio regrediu o status por cima — visto em 2026-06-12).
// A transição normal acontece no MESMO handler que preenche a chave, em
// segundos; 30min parado com chave preenchida é estado morto.
const NF_PRESA_GRACE_MS = 30 * 60 * 1000;

interface WebhookLogResumo {
  tiny_pedido_id: string;
  tipo: string;
  status: string;
  criado_em: string;
}

/**
 * Um log de aprovação bloqueia o reprocessamento do pedido?
 * - 'concluido'/'ignorado': bloqueia (pedido tratado).
 * - 'erro': não bloqueia — re-tenta, seja log do poller ou de webhook real
 *   (falha transiente de processamento não pode virar venda perdida).
 * - 'processando'/'recebido' fresco (<1h): bloqueia (processamento em voo).
 * - 'processando'/'recebido' velho (>1h): não bloqueia (função serverless
 *   morta no meio — o status nunca vai sair do lugar sozinho).
 */
function logBloqueiaReprocesso(log: WebhookLogResumo): boolean {
  if (log.status === "erro") return false;
  if (
    (log.status === "processando" || log.status === "recebido") &&
    Date.parse(log.criado_em) < Date.now() - STUCK_PROCESSANDO_MS
  ) {
    return false;
  }
  return true;
}

export interface PollingResumoEmpresa {
  empresa_id: string;
  empresa_nome: string;
  cnpj: string;
  pedidos_aprovados_vistos: number;
  pedidos_processados: number;
  pedidos_cancelados_vistos: number;
  cancelamentos_aplicados: number;
  notas_vistas: number;
  notas_processadas: number;
  webhooks_retentados: number;
  nfs_destravadas: number;
  erros: string[];
}

export interface PollingResult {
  janela_dias: number;
  data_inicial: string;
  empresas: PollingResumoEmpresa[];
  executado_em: string;
}

function dataInicialJanela(dias: number = DIAS_JANELA): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Pagina uma listagem Tiny até esgotar (ou MAX_PAGES). */
async function listarTodasPaginas<T>(
  fetchPage: (offset: number) => Promise<{ itens?: T[] }>,
): Promise<T[]> {
  const todos: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { itens } = await fetchPage(page * PAGE_LIMIT);
    const lote = itens ?? [];
    todos.push(...lote);
    if (lote.length < PAGE_LIMIT) break;
  }
  return todos;
}

// ─── Retry de webhooks falhos ───────────────────────────────────────────────

interface WebhookLogRetry extends WebhookLogResumo {
  id: string;
}

/**
 * Re-tenta webhooks de aprovação ENTREGUES cujo processamento falhou
 * (status='erro') ou morreu no meio ('processando'/'recebido' preso >1h).
 * Independe da listagem do Tiny — a varredura de aprovados filtra por data
 * de CRIAÇÃO do pedido no Tiny, então um pedido criado semanas atrás e
 * aprovado agora fica invisível pra ela; aqui a fonte é o próprio log do
 * webhook. Reusa o MESMO log (processWebhook seta processando →
 * concluido/erro nele), sem criar duplicata.
 */
async function retryWebhooksFalhos(
  empresa: EmpresaInfo,
  resumo: PollingResumoEmpresa,
): Promise<void> {
  const sb = createServiceClient();
  const agora = Date.now();
  const stuckCutoff = new Date(agora - STUCK_PROCESSANDO_MS).toISOString();
  const janelaCutoff = new Date(agora - RETRY_FALHOS_JANELA_MS).toISOString();

  const { data } = await sb
    .from("siso_webhook_logs")
    .select("id, tiny_pedido_id, tipo, status, criado_em")
    .eq("empresa_id", empresa.empresaId)
    .eq("codigo_situacao", "aprovado")
    .gte("criado_em", janelaCutoff)
    .or(`status.eq.erro,and(status.in.(processando,recebido),criado_em.lt.${stuckCutoff})`)
    .order("criado_em", { ascending: true })
    .limit(RETRY_FALHOS_MAX);

  const candidatos = (data ?? []) as WebhookLogRetry[];
  if (candidatos.length === 0) return;

  // 1 retry por pedido por run (pode haver inclusao+atualizacao falhos)
  const porPedido = new Map<string, WebhookLogRetry>();
  for (const log of candidatos) {
    if (!porPedido.has(log.tiny_pedido_id)) porPedido.set(log.tiny_pedido_id, log);
  }
  const ids = [...porPedido.keys()];

  // Pula pedidos que já existem ou com outro log que bloqueia (concluido/
  // ignorado/fresco em voo — mesma régua da varredura de aprovados).
  const conhecidos = new Set<string>();
  for (const lote of chunk(ids, 200)) {
    const [{ data: pedidos }, { data: logs }] = await Promise.all([
      sb.from("siso_pedidos").select("id").in("id", lote),
      sb
        .from("siso_webhook_logs")
        .select("tiny_pedido_id, tipo, status, criado_em")
        .eq("codigo_situacao", "aprovado")
        .in("tiny_pedido_id", lote),
    ]);
    for (const p of (pedidos ?? []) as Array<{ id: string }>) conhecidos.add(p.id);
    for (const l of (logs ?? []) as WebhookLogResumo[]) {
      if (logBloqueiaReprocesso(l)) conhecidos.add(l.tiny_pedido_id);
    }
  }

  const alvos = ids.filter((id) => !conhecidos.has(id));
  if (alvos.length === 0) return;

  logger.info(LOG_SOURCE, "Webhooks falhos detectados pra retry", {
    empresaId: empresa.empresaId,
    quantidade: alvos.length,
    ids: alvos.slice(0, 50),
  });

  for (const pedidoId of alvos) {
    const log = porPedido.get(pedidoId)!;
    try {
      await processWebhook(
        log.id,
        pedidoId,
        empresa.empresaId,
        empresa.galpaoId,
        empresa.grupoId,
      );
      resumo.webhooks_retentados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(`retry ${pedidoId}: ${msg}`);
      logger.warn(LOG_SOURCE, "Retry de webhook falhou (segue)", {
        pedidoId,
        empresaId: empresa.empresaId,
        error: msg,
      });
    }
  }
}

// ─── Pedidos aprovados ──────────────────────────────────────────────────────

async function pollPedidosAprovados(
  token: string,
  empresa: EmpresaInfo,
  cnpj: string,
  dataInicial: string,
  resumo: PollingResumoEmpresa,
): Promise<void> {
  const sb = createServiceClient();

  const aprovados = await listarTodasPaginas<TinyPedidoListItem>((offset) =>
    listarPedidos(token, {
      situacao: SITUACAO_PEDIDO_APROVADA,
      dataInicial,
      limit: PAGE_LIMIT,
      offset,
    }),
  );
  resumo.pedidos_aprovados_vistos = aprovados.length;
  if (aprovados.length === 0) return;

  const porId = new Map<string, TinyPedidoListItem>();
  for (const p of aprovados) {
    if (p?.id != null) porId.set(String(p.id), p);
  }
  const ids = [...porId.keys()];

  // Dedup em lote: pedido já existe OU já tem webhook log de aprovação que
  // bloqueia (logs com falha — erro ou presos >1h — são retryable, qualquer
  // tipo; ver logBloqueiaReprocesso).
  const conhecidos = new Set<string>();
  for (const lote of chunk(ids, 200)) {
    const [{ data: pedidos }, { data: logs }] = await Promise.all([
      sb.from("siso_pedidos").select("id").in("id", lote),
      sb
        .from("siso_webhook_logs")
        .select("tiny_pedido_id, tipo, status, criado_em")
        .eq("codigo_situacao", "aprovado")
        .in("tiny_pedido_id", lote),
    ]);
    for (const p of (pedidos ?? []) as Array<{ id: string }>) conhecidos.add(p.id);
    for (const l of (logs ?? []) as WebhookLogResumo[]) {
      if (logBloqueiaReprocesso(l)) conhecidos.add(l.tiny_pedido_id);
    }
  }

  const novos = ids.filter((id) => !conhecidos.has(id));
  if (novos.length === 0) return;

  logger.info(LOG_SOURCE, "Pedidos aprovados sem webhook detectados", {
    empresaId: empresa.empresaId,
    quantidade: novos.length,
    ids: novos.slice(0, 50),
  });

  for (const pedidoId of novos) {
    try {
      // Re-check imediatamente antes de processar: o snapshot de dedup acima
      // fica stale durante o processamento serial (rate-limited, minutos com
      // backlog) e o dedup_key NÃO colide com logs de webhook real. Encolhe a
      // janela da corrida poll × webhook atrasado pra sub-segundo.
      const [{ data: jaExiste }, { data: logsAtuais }] = await Promise.all([
        sb.from("siso_pedidos").select("id").eq("id", pedidoId).maybeSingle(),
        sb
          .from("siso_webhook_logs")
          .select("tiny_pedido_id, tipo, status, criado_em")
          .eq("codigo_situacao", "aprovado")
          .eq("tiny_pedido_id", pedidoId),
      ]);
      if (jaExiste) continue;
      if (((logsAtuais ?? []) as WebhookLogResumo[]).some(logBloqueiaReprocesso)) {
        continue;
      }

      let webhookLogId: string;
      const { data: logEntry, error: insertError } = await sb
        .from("siso_webhook_logs")
        .insert({
          tiny_pedido_id: pedidoId,
          cnpj,
          tipo: "polling_pedido",
          codigo_situacao: "aprovado",
          filial: empresa.galpaoNome,
          empresa_id: empresa.empresaId,
          payload: { origem: "polling", dados: porId.get(pedidoId) ?? { id: pedidoId } },
        })
        .select("id")
        .single();

      if (insertError) {
        if (insertError.code !== "23505") {
          resumo.erros.push(`pedido ${pedidoId}: ${insertError.message}`);
          continue;
        }
        // 23505 aqui só pode ser nosso PRÓPRIO log de poll anterior (logs de
        // webhook real têm dedup_key diferente). Reusa e re-tenta apenas se o
        // log existente for retryable (erro/preso) — um log fresco de outro
        // poll concorrente bloqueia.
        const { data: existente } = await sb
          .from("siso_webhook_logs")
          .select("id, tiny_pedido_id, tipo, status, criado_em")
          .eq("tiny_pedido_id", pedidoId)
          .eq("tipo", "polling_pedido")
          .eq("codigo_situacao", "aprovado")
          .single();
        if (!existente || logBloqueiaReprocesso(existente as WebhookLogResumo & { id: string })) {
          continue;
        }
        webhookLogId = existente.id;
      } else {
        webhookLogId = logEntry.id;
      }

      await processWebhook(
        webhookLogId,
        pedidoId,
        empresa.empresaId,
        empresa.galpaoId,
        empresa.grupoId,
      );
      resumo.pedidos_processados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(`pedido ${pedidoId}: ${msg}`);
      logger.warn(LOG_SOURCE, "Falha processando pedido via polling (segue)", {
        pedidoId,
        empresaId: empresa.empresaId,
        error: msg,
      });
    }
  }
}

// ─── Pedidos cancelados ─────────────────────────────────────────────────────

async function pollPedidosCancelados(
  token: string,
  empresa: EmpresaInfo,
  cnpj: string,
  dataInicial: string,
  resumo: PollingResumoEmpresa,
): Promise<void> {
  const sb = createServiceClient();

  // dataAtualizacao (não dataInicial): cancelamento acontece dias/semanas
  // depois da CRIAÇÃO do pedido (claim ML, desistência). Filtrar por data de
  // criação deixaria pra sempre vivo no SISO um pedido criado há >7d e
  // cancelado hoje. O cancelamento atualiza o pedido no Tiny, então a janela
  // de 7d por atualização cobre pedidos velhos cancelados recentemente.
  let cancelados: TinyPedidoListItem[];
  try {
    cancelados = await listarTodasPaginas<TinyPedidoListItem>((offset) =>
      listarPedidos(token, {
        situacao: SITUACAO_PEDIDO_CANCELADA,
        dataAtualizacao: dataInicial,
        limit: PAGE_LIMIT,
        offset,
      }),
    );
  } catch (err) {
    // Tiny recusa dataAtualizacao em contas grandes ("Sua consulta levou
    // muito tempo" — visto na EasyPeasy). Degrada pra janela por data de
    // criação: perde cancelamentos de pedidos criados há >7d, mas cobre o
    // grosso em vez de nada.
    logger.warn(LOG_SOURCE, "Listagem por dataAtualizacao falhou — fallback pra dataInicial", {
      empresaId: empresa.empresaId,
      error: err instanceof Error ? err.message : String(err),
    });
    cancelados = await listarTodasPaginas<TinyPedidoListItem>((offset) =>
      listarPedidos(token, {
        situacao: SITUACAO_PEDIDO_CANCELADA,
        dataInicial,
        limit: PAGE_LIMIT,
        offset,
      }),
    );
  }
  resumo.pedidos_cancelados_vistos = cancelados.length;
  if (cancelados.length === 0) return;

  const ids = [...new Set(cancelados.filter((p) => p?.id != null).map((p) => String(p.id)))];

  // Só interessam pedidos que o SISO conhece e ainda não estão cancelados.
  const alvos: string[] = [];
  for (const lote of chunk(ids, 200)) {
    const { data: pedidos } = await sb
      .from("siso_pedidos")
      .select("id, status")
      .in("id", lote)
      .neq("status", "cancelado");
    for (const p of (pedidos ?? []) as Array<{ id: string }>) alvos.push(p.id);
  }
  if (alvos.length === 0) return;

  logger.info(LOG_SOURCE, "Cancelamentos perdidos detectados", {
    empresaId: empresa.empresaId,
    quantidade: alvos.length,
    ids: alvos.slice(0, 50),
  });

  for (const pedidoId of alvos) {
    try {
      let webhookLogId: string;
      const { data: logEntry, error: insertError } = await sb
        .from("siso_webhook_logs")
        .insert({
          tiny_pedido_id: pedidoId,
          cnpj,
          tipo: "polling_pedido",
          codigo_situacao: "cancelado",
          filial: empresa.galpaoNome,
          empresa_id: empresa.empresaId,
          payload: { origem: "polling", dados: { id: pedidoId } },
        })
        .select("id")
        .single();

      if (insertError) {
        if (insertError.code !== "23505") {
          resumo.erros.push(`cancel ${pedidoId}: ${insertError.message}`);
          continue;
        }
        // Log de um poll anterior cujo cancelamento não concluiu (status do
        // pedido segue != cancelado) — reusa o log e re-tenta; o handler é
        // idempotente.
        const { data: existente } = await sb
          .from("siso_webhook_logs")
          .select("id")
          .eq("tiny_pedido_id", pedidoId)
          .eq("tipo", "polling_pedido")
          .eq("codigo_situacao", "cancelado")
          .single();
        if (!existente) continue;
        webhookLogId = existente.id;
      } else {
        webhookLogId = logEntry.id;
      }

      await handlePedidoCancelamento({
        pedidoId,
        webhookLogId,
        empresaId: empresa.empresaId,
      });
      resumo.cancelamentos_aplicados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(`cancel ${pedidoId}: ${msg}`);
      logger.warn(LOG_SOURCE, "Falha cancelando pedido via polling (segue)", {
        pedidoId,
        empresaId: empresa.empresaId,
        error: msg,
      });
    }
  }
}

// ─── Notas fiscais autorizadas ──────────────────────────────────────────────

async function pollNotasAutorizadas(
  token: string,
  empresa: EmpresaInfo,
  cnpj: string,
  dataInicial: string,
  resumo: PollingResumoEmpresa,
): Promise<void> {
  const sb = createServiceClient();

  const porId = new Map<string, TinyNotaListItem>();
  for (const situacao of SITUACOES_NF) {
    const notas = await listarTodasPaginas<TinyNotaListItem>((offset) =>
      listarNotas(token, { situacao, dataInicial, limit: PAGE_LIMIT, offset }),
    );
    for (const nf of notas) {
      if (nf?.id != null) porId.set(String(nf.id), nf);
    }
  }
  resumo.notas_vistas = porId.size;
  if (porId.size === 0) return;

  // Pré-dedup por id (o handler ainda faz o dedup composto por chaveAcesso).
  // Log em 'aguardando_pedido' NÃO conta como conhecida: a NF chegou antes do
  // pedido existir e o handler tem retry de match exatamente pra re-entrega
  // (23505 → reusa o log pendente) — mas esse retry só dispara se o polling
  // re-entregar. Contar como conhecida deixava a NF órfã pra sempre.
  const ids = [...porId.keys()];
  const conhecidas = new Set<string>();
  for (const lote of chunk(ids, 200)) {
    const { data: logs } = await sb
      .from("siso_webhook_logs")
      .select("tiny_pedido_id, status")
      .eq("tipo", "nota_fiscal")
      .in("tiny_pedido_id", lote);
    for (const l of (logs ?? []) as Array<{ tiny_pedido_id: string; status: string }>) {
      if (l.status !== "aguardando_pedido") conhecidas.add(l.tiny_pedido_id);
    }
  }

  const novas = ids.filter((id) => !conhecidas.has(id));
  if (novas.length === 0) return;

  logger.info(LOG_SOURCE, "NFs autorizadas sem webhook detectadas", {
    empresaId: empresa.empresaId,
    quantidade: novas.length,
    ids: novas.slice(0, 50),
  });

  for (const nfId of novas) {
    const nf = porId.get(nfId);
    if (!nf) continue;
    try {
      const payload: NfWebhookPayload = {
        cnpj,
        tipo: "nota_fiscal",
        dados: {
          idNotaFiscalTiny: nf.id,
          numero: nf.numero,
          serie: nf.serie,
          chaveAcesso: nf.chaveAcesso,
          dataEmissao: nf.dataEmissao,
          valorNota: nf.valor,
        },
      };
      await handleNfWebhook(payload, empresa.empresaId, { aguardarFase1: true });
      resumo.notas_processadas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(`nf ${nfId}: ${msg}`);
      logger.warn(LOG_SOURCE, "Falha processando NF via polling (segue)", {
        nfId,
        empresaId: empresa.empresaId,
        error: msg,
      });
    }
  }
}

// ─── NFs autorizadas presas (transição perdida) ─────────────────────────────

/**
 * Destrava pedidos parados em aguardando_nf cuja NF JÁ foi processada:
 * nota_fiscal_id + chave_acesso_nf preenchidos há >30min e status que não
 * andou. Acontece quando a transição se perde (ex.: reprocesso tardio de
 * webhook regrediu o status por cima dela — caso zumbi de 2026-06-12). O
 * pré-dedup do polling de NFs pula NF com log existente, então sem esta
 * varredura o pedido fica preso pra sempre.
 *
 * Guard: exige log de NF visto (webhook/poll processou a autorização) —
 * chave preenchida por outro caminho sem NF autorizada não transiciona.
 */
async function recuperarNfsPresas(
  empresa: EmpresaInfo,
  resumo: PollingResumoEmpresa,
): Promise<void> {
  const sb = createServiceClient();
  const cutoff = new Date(Date.now() - NF_PRESA_GRACE_MS).toISOString();

  const { data } = await sb
    .from("siso_pedidos")
    .select("id, numero, nota_fiscal_id")
    .eq("empresa_origem_id", empresa.empresaId)
    .neq("status", "cancelado")
    .eq("status_separacao", "aguardando_nf")
    .not("nota_fiscal_id", "is", null)
    .not("chave_acesso_nf", "is", null)
    .lt("criado_em", cutoff)
    .limit(20);

  const presos = (data ?? []) as Array<{
    id: string;
    numero: string;
    nota_fiscal_id: number;
  }>;
  if (presos.length === 0) return;

  // Evidência de NF autorizada vista: log tipo='nota_fiscal' do NF id
  const nfIds = presos.map((p) => String(p.nota_fiscal_id));
  const { data: logsNf } = await sb
    .from("siso_webhook_logs")
    .select("tiny_pedido_id")
    .eq("tipo", "nota_fiscal")
    .in("tiny_pedido_id", nfIds);
  const nfVistas = new Set(
    ((logsNf ?? []) as Array<{ tiny_pedido_id: string }>).map(
      (l) => l.tiny_pedido_id,
    ),
  );

  for (const p of presos) {
    if (!nfVistas.has(String(p.nota_fiscal_id))) continue;
    try {
      const { data: updated } = await sb
        .from("siso_pedidos")
        .update({ status_separacao: "aguardando_separacao" })
        .eq("id", p.id)
        .eq("status_separacao", "aguardando_nf")
        .select("id");
      if (!updated || updated.length === 0) continue;

      resumo.nfs_destravadas++;
      logger.info(LOG_SOURCE, "Pedido preso em aguardando_nf destravado", {
        pedidoId: p.id,
        numero: p.numero,
        empresaId: empresa.empresaId,
      });
      // Fase-1 do agrupamento (idempotente; no-op se já existe)
      await criarAgrupamentoFase1(p.id).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(`nf-presa ${p.id}: ${msg}`);
    }
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Varre todas as contas Tiny conectadas (siso_tiny_connections ativas com
 * empresa vinculada) e reprocessa pedidos/NFs que escaparam do webhook.
 * Erros são isolados por empresa e por item — uma falha não derruba o resto.
 */
export async function pollTiny(): Promise<PollingResult> {
  const sb = createServiceClient();
  const dataInicial = dataInicialJanela();
  const dataInicialAprovados = dataInicialJanela(DIAS_JANELA_APROVADOS);

  const { data: connections, error } = await sb
    .from("siso_tiny_connections")
    .select("cnpj, empresa_id")
    .eq("ativo", true)
    .not("empresa_id", "is", null)
    .not("access_token", "is", null);

  if (error) {
    throw new Error(`Falha listando conexões Tiny: ${error.message}`);
  }

  // Empresa desativada = recusa pedidos novos (o webhook já filtra via
  // getEmpresaByCnpj.eq("ativo", true)). O polling é o fallback do webhook,
  // então também precisa pular essas. Filtro em 2 queries via Set — não há FK
  // declarada entre siso_tiny_connections e siso_empresas pra PostgREST juntar.
  const { data: empresasAtivas, error: empresasError } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true);
  if (empresasError) {
    throw new Error(`Falha listando empresas ativas: ${empresasError.message}`);
  }
  const ativasSet = new Set(
    (empresasAtivas ?? []).map((e) => (e as { id: string }).id),
  );

  const connectionsTodas = (connections ?? []) as Array<{
    cnpj: string;
    empresa_id: string;
  }>;
  const connectionsAtivas = connectionsTodas.filter((c) =>
    ativasSet.has(c.empresa_id),
  );
  const puladas = connectionsTodas.filter((c) => !ativasSet.has(c.empresa_id));
  if (puladas.length > 0) {
    logger.info(LOG_SOURCE, "empresas inativas puladas", {
      empresa_ids: puladas.map((c) => c.empresa_id),
    });
  }

  const resultado: PollingResult = {
    janela_dias: DIAS_JANELA,
    data_inicial: dataInicial,
    empresas: [],
    executado_em: new Date().toISOString(),
  };

  for (const conn of connectionsAtivas) {
    const resumo: PollingResumoEmpresa = {
      empresa_id: conn.empresa_id,
      empresa_nome: "",
      cnpj: conn.cnpj,
      pedidos_aprovados_vistos: 0,
      pedidos_processados: 0,
      pedidos_cancelados_vistos: 0,
      cancelamentos_aplicados: 0,
      notas_vistas: 0,
      notas_processadas: 0,
      webhooks_retentados: 0,
      nfs_destravadas: 0,
      erros: [],
    };
    resultado.empresas.push(resumo);

    try {
      const empresa = await getEmpresaByCnpj(conn.cnpj);
      if (!empresa) {
        resumo.erros.push("empresa não encontrada/inativa pra esse CNPJ");
        continue;
      }
      resumo.empresa_nome = empresa.empresaNome;

      const { token } = await getValidTokenByEmpresa(empresa.empresaId);

      // runWithEmpresa: rate-limit + contexto pro stub (gotcha #8).
      // Cada varredura é isolada: erro numa (ex.: Tiny 400 na listagem de
      // cancelados) não derruba as demais da mesma empresa.
      await runWithEmpresa(empresa.empresaId, async () => {
        const varreduras: Array<[string, () => Promise<void>]> = [
          ["retry-falhos", () => retryWebhooksFalhos(empresa, resumo)],
          ["aprovados", () => pollPedidosAprovados(token, empresa, conn.cnpj, dataInicialAprovados, resumo)],
          ["cancelados", () => pollPedidosCancelados(token, empresa, conn.cnpj, dataInicial, resumo)],
          ["notas", () => pollNotasAutorizadas(token, empresa, conn.cnpj, dataInicial, resumo)],
          ["nfs-presas", () => recuperarNfsPresas(empresa, resumo)],
        ];
        for (const [nome, varrer] of varreduras) {
          try {
            await varrer();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            resumo.erros.push(`varredura ${nome}: ${msg}`);
            logger.warn(LOG_SOURCE, `Varredura ${nome} falhou (segue pras demais)`, {
              empresaId: empresa.empresaId,
              error: msg,
            });
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(msg);
      logger.logError({
        error: err,
        source: LOG_SOURCE,
        message: `Polling falhou pra empresa ${conn.empresa_id}`,
        category: "external_api",
        empresaId: conn.empresa_id,
        metadata: { cnpj: conn.cnpj },
      });
    }
  }

  logger.info(LOG_SOURCE, "Polling Tiny concluído", {
    empresas: resultado.empresas.length,
    pedidos: resultado.empresas.reduce((s, e) => s + e.pedidos_processados, 0),
    cancelamentos: resultado.empresas.reduce((s, e) => s + e.cancelamentos_aplicados, 0),
    notas: resultado.empresas.reduce((s, e) => s + e.notas_processadas, 0),
    erros: resultado.empresas.reduce((s, e) => s + e.erros.length, 0),
  });

  return resultado;
}
