// Serviço de impressão de etiquetas de produto (recebimento + guarda).
//
// Compõe: geração de ZPL pareado 2-por-folha + resolução da impressora
// (com fallback pra impressora de envio se a de produto não estiver
// configurada) + envio ao PrintNode.
//
// Idempotência: o caller é responsável por não chamar 2x pro mesmo evento
// (re-imprimir é OK — é um ato voluntário). Erros não revertem o ledger;
// recebimento e guarda gravam ANTES de imprimir.

import { createHash } from "node:crypto";
import {
  enviarImpressaoZpl,
  resolverImpressoraExcesso,
  resolverImpressoraProduto,
} from "@/lib/printnode";
import { logger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase-server";
import {
  gerarZplProduto,
  expandirPorQty,
  contarFolhas,
  type EtiquetaProdutoInput,
} from "./zpl-produto";
import { gerarZplExcesso, type EtiquetaExcessoInput } from "./zpl-excesso";

const LOG_SOURCE = "wms.etiqueta-produto";

export interface ImprimirEtiquetasInput {
  usuarioId: string;
  galpaoId: string;
  /**
   * Linhas a imprimir. Cada linha vira `qty` etiquetas físicas
   * (1 por unidade). Ordem preservada na sequência impressa.
   */
  linhas: { etiqueta: EtiquetaProdutoInput; qty: number }[];
  /** Título do print job (aparece no PrintNode). */
  titulo: string;
  /** Contexto pra fila de impressões — ex: 'guarda', 'lote', 'manual'. */
  contexto?: string;
  /** ID de referência do contexto (ex: pendencia_id, pedido_id). */
  contextoRefId?: string;
}

export interface ImprimirEtiquetasResult {
  ok: boolean;
  error?: string;
  jobId?: number;
  totalEtiquetas?: number;
  totalFolhas?: number;
  printerId?: number;
  printerNome?: string;
  fallbackEnvelope?: boolean;
}

/**
 * Imprime etiquetas de produto. Não lança — devolve `{ok: false, error}` se
 * algo falhou. O caller decide se isso é fatal pro fluxo (no recebimento,
 * tipicamente não — o ledger já foi gravado).
 *
 * **Persistência de falhas:** quando a chamada ao PrintNode falha, o erro é
 * gravado em `siso_logs` (info estruturado) **e** em `siso_erros` (stack +
 * categoria `external_api` + correlation id quando disponível) via
 * `logger.logError`. Isso garante que falhas de impressão sejam auditáveis
 * fora do escopo do request (timeouts, conta inativa, printer offline) — o
 * operador pode reimprimir via `/api/wms/guarda/imprimir-lote` ou
 * `/api/wms/guarda/[id]/imprimir` sem perda de informação histórica.
 */
export async function imprimirEtiquetasProduto(
  input: ImprimirEtiquetasInput,
): Promise<ImprimirEtiquetasResult> {
  if (input.linhas.length === 0) {
    return { ok: false, error: "nenhuma etiqueta pra imprimir" };
  }

  const etiquetas = expandirPorQty(input.linhas);
  const totalEtiquetas = etiquetas.length;
  const totalFolhas = contarFolhas(totalEtiquetas);

  // Resolve impressora (com api_key embutida da conta dona da impressora).
  const printer = await resolverImpressoraProduto(input.usuarioId, input.galpaoId);

  if (!printer) {
    logger.warn(LOG_SOURCE, "nenhuma impressora configurada (ou conta inativa)", {
      usuarioId: input.usuarioId,
      galpaoId: input.galpaoId,
    });
    return { ok: false, error: "Nenhuma impressora configurada (produto nem envio)" };
  }

  if (printer.fallbackEnvelope) {
    logger.warn(LOG_SOURCE, "usando impressora de envio como fallback", {
      galpaoId: input.galpaoId,
      printerId: String(printer.printerId),
    });
  }

  const zpl = gerarZplProduto(etiquetas);

  // [Fix-D #5.7] Insert preliminar em siso_impressoes_log com status='enviado'.
  // Update pra 'sucesso' ou 'erro' depois do PrintNode. Operador pode reimprimir
  // via /wms/etiquetas (botão Retry) sem perder histórico.
  const sb = createServiceClient();
  const payloadHash = createHash("sha256").update(zpl).digest("hex");
  let logId: string | null = null;
  try {
    const { data: logRow } = await sb
      .from("siso_impressoes_log")
      .insert({
        printer_id: printer.printerId,
        printer_nome: printer.printerNome,
        payload_zpl: zpl,
        payload_hash: payloadHash,
        contexto: input.contexto ?? "manual",
        contexto_ref_id: input.contextoRefId ?? null,
        total_etiquetas: totalEtiquetas,
        status: "enviado",
        usuario_id: input.usuarioId,
        galpao_id: input.galpaoId,
      })
      .select("id")
      .single();
    logId = (logRow as { id: string } | null)?.id ?? null;
  } catch (e) {
    // Insert log falhar não bloqueia o print — só perde auditoria
    logger.warn(LOG_SOURCE, "falha ao inserir siso_impressoes_log (insert)", {
      e: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const { jobId } = await enviarImpressaoZpl({
      apiKey: printer.apiKey,
      printerId: printer.printerId,
      zpl,
      titulo: input.titulo,
    });
    if (logId) {
      await sb
        .from("siso_impressoes_log")
        .update({
          printnode_job_id: jobId,
          status: "sucesso",
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", logId);
    }
    logger.info(LOG_SOURCE, "etiquetas de produto impressas", {
      jobId: String(jobId),
      totalEtiquetas: String(totalEtiquetas),
      totalFolhas: String(totalFolhas),
      printerId: String(printer.printerId),
      fallback: String(printer.fallbackEnvelope),
    });
    return {
      ok: true,
      jobId,
      totalEtiquetas,
      totalFolhas,
      printerId: printer.printerId,
      printerNome: printer.printerNome,
      fallbackEnvelope: printer.fallbackEnvelope,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logId) {
      await sb
        .from("siso_impressoes_log")
        .update({
          status: "erro",
          erro_msg: msg,
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", logId);
    }
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "falha ao enviar impressão pro PrintNode",
      category: "external_api",
      metadata: {
        printerId: printer.printerId,
        totalEtiquetas,
        galpaoId: input.galpaoId,
        impressao_log_id: logId,
      },
    });
    return { ok: false, error: msg };
  }
}

export interface ImprimirEtiquetaExcessoInput {
  usuarioId: string;
  galpaoId: string;
  etiqueta: EtiquetaExcessoInput;
  /**
   * Nº de vias FÍSICAS da mesma etiqueta (default 1). Não confundir com
   * `etiqueta.qty`, que é o número ESTAMPADO nela.
   */
  copias?: number;
  /** Título do print job (aparece no PrintNode). */
  titulo: string;
  /** ID de referência do contexto (ex: produto_id). */
  contextoRefId?: string;
}

/**
 * Imprime N vias da etiqueta de excesso 10×15 (paisagem, qty estampada).
 *
 * Diferente da etiqueta de produto pequena: vai pra impressora de EXCESSO do
 * galpão (`resolverImpressoraExcesso`), que cai pra de envio quando não
 * configurada — é a que tem mídia 10×15. Mesmo contrato de erro do
 * imprimirEtiquetasProduto: não lança, devolve `{ok: false, error}`.
 */
export async function imprimirEtiquetaExcesso(
  input: ImprimirEtiquetaExcessoInput,
): Promise<ImprimirEtiquetasResult> {
  const copias = Math.max(1, Math.floor(input.copias ?? 1));
  const printer = await resolverImpressoraExcesso(input.usuarioId, input.galpaoId);

  if (!printer) {
    logger.warn(LOG_SOURCE, "nenhuma impressora configurada (excesso)", {
      usuarioId: input.usuarioId,
      galpaoId: input.galpaoId,
    });
    return { ok: false, error: "Nenhuma impressora configurada (excesso nem envio)" };
  }

  if (printer.fallbackEnvelope) {
    logger.warn(LOG_SOURCE, "usando impressora de envio como fallback (excesso)", {
      galpaoId: input.galpaoId,
      printerId: String(printer.printerId),
    });
  }

  // Vias idênticas: repete o ZPL inteiro (mesmo padrão do zpl-produto).
  const zplUnitario = gerarZplExcesso(input.etiqueta);
  const zpl = Array.from({ length: copias }, () => zplUnitario).join("\n");

  const sb = createServiceClient();
  const payloadHash = createHash("sha256").update(zpl).digest("hex");
  let logId: string | null = null;
  try {
    const { data: logRow } = await sb
      .from("siso_impressoes_log")
      .insert({
        printer_id: printer.printerId,
        printer_nome: printer.printerNome,
        payload_zpl: zpl,
        payload_hash: payloadHash,
        contexto: "excesso",
        contexto_ref_id: input.contextoRefId ?? null,
        total_etiquetas: copias,
        status: "enviado",
        usuario_id: input.usuarioId,
        galpao_id: input.galpaoId,
      })
      .select("id")
      .single();
    logId = (logRow as { id: string } | null)?.id ?? null;
  } catch (e) {
    logger.warn(LOG_SOURCE, "falha ao inserir siso_impressoes_log (insert)", {
      e: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const { jobId } = await enviarImpressaoZpl({
      apiKey: printer.apiKey,
      printerId: printer.printerId,
      zpl,
      titulo: input.titulo,
    });
    if (logId) {
      await sb
        .from("siso_impressoes_log")
        .update({
          printnode_job_id: jobId,
          status: "sucesso",
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", logId);
    }
    logger.info(LOG_SOURCE, "etiqueta de excesso impressa", {
      jobId: String(jobId),
      sku: input.etiqueta.sku,
      qty: String(input.etiqueta.qty),
      copias: String(copias),
      printerId: String(printer.printerId),
      fallback: String(printer.fallbackEnvelope),
    });
    return {
      ok: true,
      jobId,
      totalEtiquetas: copias,
      totalFolhas: copias,
      printerId: printer.printerId,
      printerNome: printer.printerNome,
      fallbackEnvelope: printer.fallbackEnvelope,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logId) {
      await sb
        .from("siso_impressoes_log")
        .update({
          status: "erro",
          erro_msg: msg,
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", logId);
    }
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "falha ao enviar etiqueta de excesso pro PrintNode",
      category: "external_api",
      metadata: {
        printerId: printer.printerId,
        galpaoId: input.galpaoId,
        impressao_log_id: logId,
      },
    });
    return { ok: false, error: msg };
  }
}
