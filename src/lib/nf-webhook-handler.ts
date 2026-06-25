/**
 * Handler for Tiny webhook tipo "nota_fiscal".
 *
 * When a NF is authorized by SEFAZ, Tiny sends this webhook.
 * We match the NF to an existing pedido and transition it
 * from aguardando_nf → aguardando_separacao, saving DANFE URL and chave de acesso.
 */

import { createServiceClient } from "./supabase-server";
import { obterNotaFiscal, type TinyNotaFiscal } from "./tiny-api";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { logger } from "./logger";
import { registrarEvento } from "./historico-service";
import { criarAgrupamentoFase1 } from "./agrupamento-service";
import { dispararCutoverSePronto } from "./wms/cutover";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NfWebhookPayload {
  cnpj: string;
  tipo: string;
  dados: {
    idNotaFiscalTiny: number;
    numero?: string;
    serie?: string;
    urlDanfe?: string;
    chaveAcesso?: string;
    dataEmissao?: string;
    valorNota?: number;
  };
}

// ─── Devolução detection (single source of truth) ──────────────────────────
/**
 * Detecta se um payload de NF representa devolução.
 *
 * Tiny entrega o tipo de devolução em formas variadas dependendo do canal e
 * do tipo de payload — `tipo` no envelope, `tipoOperacao`/`tipo_operacao`
 * (E = entrada), `tipo_nota`, ou `finalidade` (Tiny v3 carrega 4=devolução
 * em alguns webhooks). Centralizar a checagem aqui evita branches divergentes
 * entre o webhook receiver e o handler.
 */
export function isDevolucao(nf: {
  tipo?: string;
  tipoOperacao?: string;
  finalidade?: string;
  origem?: { tipo?: string | null } | null;
}): boolean {
  if (nf.tipo && nf.tipo.toLowerCase() === "devolucao") return true;
  if (nf.tipoOperacao === "E") return true;
  if (nf.finalidade && /devol/i.test(nf.finalidade)) return true;
  // [Fix-D #6.12] Tiny v3 carrega 'devolucao' em origem.tipo no /notas/{id}
  // (TinyNotaFiscal). Garantir que esse caminho também classifica.
  if (nf.origem?.tipo && nf.origem.tipo.toLowerCase() === "devolucao") return true;
  return false;
}

// ─── upsertNotaFiscal helper (Fix-Final A T6 / R5) ─────────────────────────
/**
 * Garante existência de uma linha em `siso_notas_fiscais` (tabela canônica)
 * e retorna seu UUID. Usado por `classificarDevolucao` e pelo handler de NF
 * de saída antes de chamar `inserirMovimentacao` (que exige uuid em
 * `nota_fiscal_id` por causa da FK adicionada na migration T5).
 *
 * Dedup priorizado:
 * 1. `chave_acesso` quando presente (UNIQUE)
 * 2. `tiny_nota_fiscal_id` como fallback
 * 3. INSERT
 *
 * Race-safe na prática (chave_acesso UNIQUE), mas em race extremo o segundo
 * INSERT estoura 23505 e o caller deve retry — não tentamos handle aqui pra
 * manter código simples; a probabilidade real é desprezível (1 webhook por NF
 * + dedup upstream em siso_webhook_logs).
 */
export type UpsertNfInput = {
  tiny_nota_fiscal_id?: number | string | null;
  chave_acesso?: string | null;
  numero?: string | null;
  serie?: string | null;
  empresa_id?: string | null;
  tipo: "entrada" | "saida";
  raw?: unknown;
};

export async function upsertNotaFiscal(input: UpsertNfInput): Promise<string> {
  const sb = createServiceClient();
  const chave = input.chave_acesso?.trim() || null;
  const tinyId = input.tiny_nota_fiscal_id != null && input.tiny_nota_fiscal_id !== ""
    ? Number(input.tiny_nota_fiscal_id)
    : null;

  if (chave) {
    const { data: existing } = await sb
      .from("siso_notas_fiscais")
      .select("id")
      .eq("chave_acesso", chave)
      .maybeSingle();
    if (existing) return (existing as { id: string }).id;
  }
  if (tinyId != null) {
    const { data: existing } = await sb
      .from("siso_notas_fiscais")
      .select("id")
      .eq("tiny_nota_fiscal_id", tinyId)
      .maybeSingle();
    if (existing) return (existing as { id: string }).id;
  }

  const { data, error } = await sb
    .from("siso_notas_fiscais")
    .insert({
      tiny_nota_fiscal_id: tinyId,
      chave_acesso: chave,
      numero: input.numero ?? null,
      serie: input.serie ?? null,
      empresa_id: input.empresa_id ?? null,
      tipo: input.tipo,
      raw_tiny: (input.raw as Record<string, unknown> | null | undefined) ?? null,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`upsertNotaFiscal falhou: ${error.message}`);
  }
  return (data as { id: string }).id;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleNfWebhook(
  payload: NfWebhookPayload,
  empresaId: string,
  opts?: { aguardarFase1?: boolean },
): Promise<void> {
  const supabase = createServiceClient();
  const { idNotaFiscalTiny, urlDanfe, chaveAcesso } = payload.dados;

  // Step 0 — Dedup defensivo composto (nota_fiscal_id + chave_acesso) [#P6-6.33]
  // O dedup_key generated cobre tiny_pedido_id+tipo+codigo_situacao. Pra NF, Tiny
  // pode re-emitir com idNotaFiscalTiny diferente mas mesma chave de acesso
  // (raro, mas acontece em re-emissões pós-cancelamento). Lookup composto
  // captura ambos os casos antes de inserir um log duplicado já processado.
  const idAsText = String(idNotaFiscalTiny);
  const dedupResults = await Promise.all([
    supabase
      .from("siso_webhook_logs")
      .select("id, processado_em")
      .eq("tipo", "nota_fiscal")
      .eq("tiny_pedido_id", idAsText)
      .not("processado_em", "is", null)
      .limit(1)
      .maybeSingle(),
    chaveAcesso
      ? supabase
          .from("siso_webhook_logs")
          .select("id, processado_em")
          .eq("tipo", "nota_fiscal")
          .filter("payload->dados->>chaveAcesso", "eq", chaveAcesso)
          .not("processado_em", "is", null)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const priorById = dedupResults[0].data;
  const priorByChave = dedupResults[1].data;
  if (priorById || priorByChave) {
    logger.info("nf-webhook", "NF já processada previamente — skip dedup composto", {
      idNotaFiscalTiny: idAsText,
      chaveAcesso: chaveAcesso ?? null,
      priorLogId: (priorById ?? priorByChave)?.id,
      matchedBy: priorById ? "nota_fiscal_id" : "chave_acesso_nf",
    });
    return;
  }

  // Step 1 — Dedup via siso_webhook_logs unique index on dedup_key (generated column)
  const { data: logEntry, error: insertError } = await supabase
    .from("siso_webhook_logs")
    .insert({
      tiny_pedido_id: String(idNotaFiscalTiny),
      cnpj: payload.cnpj,
      tipo: "nota_fiscal",
      empresa_id: empresaId,
      payload: payload as unknown as Record<string, unknown>,
    })
    .select("id")
    .single();

  let webhookLogId: string;

  if (insertError) {
    if (insertError.code === "23505") {
      // Re-entrega de NF já vista. Se o log anterior ficou pendente —
      // 'aguardando_pedido' (NF chegou ANTES do pedido — race) ou
      // 'aguardando_autorizacao' (NF ainda não autorizada no SEFAZ) — re-tenta
      // o match/gate agora: o pedido pode já existir e/ou a NF pode ter sido
      // autorizada. Sem isso, a NF fica órfã pra sempre (o dedup engolia todas
      // as re-entregas, inclusive as do polling de 10min que serviriam de
      // segunda chance).
      const { data: pendente } = await supabase
        .from("siso_webhook_logs")
        .select("id")
        .eq("tipo", "nota_fiscal")
        .eq("tiny_pedido_id", idAsText)
        .in("status", ["aguardando_pedido", "aguardando_autorizacao"])
        .is("processado_em", null)
        .limit(1)
        .maybeSingle();
      if (!pendente) {
        logger.info("nf-webhook", "Duplicate NF webhook ignored", {
          idNotaFiscalTiny: String(idNotaFiscalTiny),
          empresaId,
        });
        return;
      }
      logger.info("nf-webhook", "NF aguardando_pedido re-entregue — retry de match", {
        idNotaFiscalTiny: String(idNotaFiscalTiny),
        empresaId,
        logId: pendente.id,
      });
      webhookLogId = pendente.id;
    } else {
      logger.error("nf-webhook", "Failed to insert webhook log", {
        idNotaFiscalTiny: String(idNotaFiscalTiny),
        empresaId,
        error: insertError.message,
      });
      throw new Error(`Failed to insert NF webhook log: ${insertError.message}`);
    }
  } else {
    webhookLogId = logEntry.id;
  }

  // NF detalhada (situacao etc): preenchida no fallback (Step 3) e reusada no
  // gate de autorização (Step 4.5); no fast-path fica null e o gate busca.
  let nfFetched: TinyNotaFiscal | null = null;

  // Step 2 — Fast-path match: pedido already has nota_fiscal_id saved
  const { data: pedidoFastPath } = await supabase
    .from("siso_pedidos")
    .select("id, status_separacao")
    .eq("nota_fiscal_id", idNotaFiscalTiny)
    .single();

  let pedidoId: string | null = pedidoFastPath?.id ?? null;

  // Step 3 — Fallback match: call Tiny API to resolve NF → pedido
  if (!pedidoId) {
    try {
      const { token } = await getValidTokenByEmpresa(empresaId);
      const nf = await runWithEmpresa(empresaId, () =>
        obterNotaFiscal(token, idNotaFiscalTiny),
      );
      nfFetched = nf;

      // [Fix-D #6.12] Antes de ignorar como "não-venda", checa se é uma
      // devolução. Tiny v3 às vezes entrega NF de devolução com
      // origem.tipo='devolucao' (ou inconsistência onde precisa do hint
      // composto via isDevolucao). Roteia pra siso_devolucoes_pendentes
      // best-effort em vez de ignorar — o webhook receiver também roteia
      // (linhas 94-121 de webhook/tiny/route.ts) mas pode não pegar quando
      // o payload base não tinha o hint e só o /notas/{id} revela.
      if (isDevolucao(nf)) {
        logger.info("nf-webhook", "NF é devolução — roteando pra fila", {
          idNotaFiscalTiny: String(idNotaFiscalTiny),
          origemTipo: nf.origem?.tipo ?? "unknown",
          empresaId,
        });
        try {
          const { registrarDevolucaoPendente } = await import("@/lib/wms/devolucoes");
          await registrarDevolucaoPendente({
            nota_fiscal_id: idNotaFiscalTiny,
            chave_acesso_nf: nf.chaveAcesso ?? undefined,
            pedido_origem_id: nf.origem?.id ?? undefined,
            empresa_id: empresaId,
            payload_webhook: payload as unknown as Record<string, unknown>,
          });
        } catch (e) {
          logger.warn("nf-webhook", "falha ao enfileirar devolução no fallback", {
            idNotaFiscalTiny: String(idNotaFiscalTiny),
            e: e instanceof Error ? e.message : String(e),
          });
        }
        await supabase
          .from("siso_webhook_logs")
          .update({ status: "roteado_devolucao", processado_em: new Date().toISOString() })
          .eq("id", webhookLogId);
        return;
      }

      // Only process sale invoices
      if (nf.origem?.tipo !== "venda") {
        logger.info("nf-webhook", "NF is not from a sale — ignoring", {
          idNotaFiscalTiny: String(idNotaFiscalTiny),
          origemTipo: nf.origem?.tipo ?? "unknown",
          empresaId,
        });
        await supabase
          .from("siso_webhook_logs")
          .update({ status: "ignorado", processado_em: new Date().toISOString() })
          .eq("id", webhookLogId);
        return;
      }

      // Find pedido by the origin order ID (origem.id = pedido_id in Tiny)
      if (nf.origem?.id) {
        const { data: pedidoByOrigem } = await supabase
          .from("siso_pedidos")
          .select("id, status_separacao")
          .eq("id", nf.origem.id)
          .single();

        if (pedidoByOrigem) {
          pedidoId = pedidoByOrigem.id;
        }
      }
    } catch (err) {
      logger.warn("nf-webhook", "Fallback NF lookup failed", {
        idNotaFiscalTiny: String(idNotaFiscalTiny),
        empresaId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 4 — Race condition: NF arrived before pedido was saved
  if (!pedidoId) {
    logger.info("nf-webhook", "No matching pedido found — saving for retry", {
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
    });
    await supabase
      .from("siso_webhook_logs")
      .update({ status: "aguardando_pedido" })
      .eq("id", webhookLogId);
    return;
  }

  // Step 4.5 — Gate de AUTORIZAÇÃO: só salva chave + transiciona se a NF estiver
  // autorizada (situacao 6=Autorizada / 7=Emitida Danfe). Uma NF rejeitada (5)/
  // pendente (1)/aguardando recibo (4/9) já tem chaveAcesso preenchida, mas não
  // é fiscal válida — avançar empurraria o pedido pra separação sem NF boa
  // (regra: "aparecer pra separar só pedido com NF autorizada"). No fast-path a
  // NF não foi buscada; busca aqui. Falha ao obter situacao = trata como
  // não-autorizada (conservador: não avança sem confirmação). NÃO marca
  // processado_em — deixa o log retryable pra quando a NF autorizar (re-entrega
  // via webhook/polling re-dispara o gate; ver dedup acima e pollNotasAutorizadas).
  const NF_AUTORIZADA = [6, 7];
  let nfSituacao: number | null =
    nfFetched?.situacao != null ? Number(nfFetched.situacao) : null;
  if (nfSituacao == null) {
    try {
      const { token } = await getValidTokenByEmpresa(empresaId);
      const nfDet = await runWithEmpresa(empresaId, () =>
        obterNotaFiscal(token, idNotaFiscalTiny),
      );
      nfSituacao = nfDet.situacao != null ? Number(nfDet.situacao) : null;
    } catch (err) {
      logger.warn("nf-webhook", "não foi possível obter situacao da NF — tratando como não-autorizada", {
        idNotaFiscalTiny: String(idNotaFiscalTiny),
        empresaId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!NF_AUTORIZADA.includes(Number(nfSituacao))) {
    logger.info("nf-webhook", "NF não autorizada — pedido não avança (aguardando autorização)", {
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      pedidoId,
      empresaId,
      situacao: nfSituacao,
    });
    await supabase
      .from("siso_webhook_logs")
      .update({ status: "aguardando_autorizacao" })
      .eq("id", webhookLogId);
    return;
  }

  // Step 5a — ALWAYS save nota_fiscal_id + NF data regardless of current status
  await supabase
    .from("siso_pedidos")
    .update({
      nota_fiscal_id: String(idNotaFiscalTiny),
      url_danfe: urlDanfe ?? null,
      chave_acesso_nf: chaveAcesso ?? null,
    })
    .eq("id", pedidoId);

  registrarEvento({
    pedidoId,
    evento: "nf_autorizada",
    detalhes: { idNotaFiscalTiny, chaveAcesso },
  }).catch(() => {});

  logger.info("nf-webhook", "NF data saved on pedido", {
    pedidoId,
    idNotaFiscalTiny: String(idNotaFiscalTiny),
    empresaId,
  });

  // Step 5a.0 — Promoção da pista FUTURA. A NF autorizada chegando = a etiqueta
  // liberou (o ML só ACEITA a NF em invoice_pending, que é a liberação). Um
  // pedido futura fica em `aguardando_separacao` (não `aguardando_nf`), então a
  // transição do Step 5b é no-op pra ele e a flag `separacao_futura` nunca cairia
  // → ficaria invisível na fila normal pra sempre (bug SEP-FUTURA-PROMO). Aqui
  // flipamos a flag e enfileiramos lancar_estoque (igual o fluxo normal — gera
  // agrupamento; pra OC, segue a compra). A NF já existe → o worker a reusa
  // (gerarNotaFiscalPedido é idempotente), não re-emite.
  const { data: pedidoFutura } = await supabase
    .from("siso_pedidos")
    .select("separacao_futura, decisao_final, empresa_origem_id")
    .eq("id", pedidoId)
    .maybeSingle();
  if (pedidoFutura?.separacao_futura === true) {
    const { promoverPedidoFutura } = await import("./webhook-processor-wms");
    await promoverPedidoFutura(supabase, {
      pedidoId,
      decisaoFinal: (pedidoFutura.decisao_final as string | null) ?? null,
      galpaoNome: null,
      empresaId: (pedidoFutura.empresa_origem_id as string | null) ?? empresaId,
    });
    logger.info("nf-webhook", "pedido futura PROMOVIDO ao receber NF (etiqueta liberou)", {
      pedidoId,
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
    });
  }

  // Step 5a.1 — Attempt fase-1 agrupamento when both NF fields are now persisted.
  // Webhook real: fire-and-forget (não bloquear a resposta pro Tiny).
  // Polling (aguardarFase1): AWAIT — fire-and-forget dentro da rota do cron
  // morre quando a lambda congela (promises soltas perdidas em serverless).
  if (chaveAcesso) {
    if (opts?.aguardarFase1) {
      await criarAgrupamentoFase1(pedidoId).catch(() => {});
    } else {
      criarAgrupamentoFase1(pedidoId).catch(() => {});
    }
  }

  // Step 5b — Transition aguardando_nf → aguardando_separacao (only if in correct status)
  const { data: transitioned } = await supabase
    .from("siso_pedidos")
    .update({ status_separacao: "aguardando_separacao" })
    .eq("id", pedidoId)
    .eq("status_separacao", "aguardando_nf")
    .select("id")
    .maybeSingle();

  if (transitioned) {
    logger.info("nf-webhook", "Pedido transitioned aguardando_nf → aguardando_separacao", {
      pedidoId,
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
    });

    // Enqueue stock posting now that NF is authorized.
    // Reads decisao_final to route to the correct stock handler.
    const { data: pedidoData } = await supabase
      .from("siso_pedidos")
      .select("decisao_final, empresa_origem_id")
      .eq("id", pedidoId)
      .single();

    if (pedidoData && ["propria", "transferencia"].includes(pedidoData.decisao_final ?? "")) {
      // O cutover só roda quando status entra no conjunto forward
      // (separado/embalado/expedido). O webhook da NF só transita pra
      // aguardando_separacao — o cutover dispara quando o operador concluir.
      // Mas se o operador concluiu ANTES da NF chegar (race), status já é
      // forward agora — o helper dispara no ato.
      const result = await dispararCutoverSePronto(pedidoId);
      logger.info("nf-webhook", "dispararCutoverSePronto chamado", {
        pedidoId,
        decisao: pedidoData.decisao_final,
        enqueued: result.enqueued,
        motivo: result.motivo,
      });
    }
  } else {
    logger.info("nf-webhook", "Pedido not in aguardando_nf — NF saved, transition skipped", {
      pedidoId,
      idNotaFiscalTiny: String(idNotaFiscalTiny),
      empresaId,
    });
  }

  // Step 6 — Mark webhook as processed
  await supabase
    .from("siso_webhook_logs")
    .update({ status: "processado", processado_em: new Date().toISOString() })
    .eq("id", webhookLogId);
}
