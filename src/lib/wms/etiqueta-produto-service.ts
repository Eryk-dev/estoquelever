// Serviço de impressão de etiquetas de produto (recebimento + guarda).
//
// Compõe: geração de ZPL pareado 2-por-folha + resolução da impressora
// (com fallback pra impressora de envio se a de produto não estiver
// configurada) + envio ao PrintNode.
//
// Idempotência: o caller é responsável por não chamar 2x pro mesmo evento
// (re-imprimir é OK — é um ato voluntário). Erros não revertem o ledger;
// recebimento e guarda gravam ANTES de imprimir.

import {
  enviarImpressaoZpl,
  resolverImpressoraProduto,
} from "@/lib/printnode";
import { logger } from "@/lib/logger";
import {
  gerarZplProduto,
  expandirPorQty,
  contarFolhas,
  type EtiquetaProdutoInput,
} from "./zpl-produto";

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

  try {
    const { jobId } = await enviarImpressaoZpl({
      apiKey: printer.apiKey,
      printerId: printer.printerId,
      zpl,
      titulo: input.titulo,
    });
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
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "falha ao enviar impressão pro PrintNode",
      category: "external_api",
      metadata: {
        printerId: printer.printerId,
        totalEtiquetas,
        galpaoId: input.galpaoId,
      },
    });
    return { ok: false, error: msg };
  }
}
