import { NextResponse } from "next/server";
import { logger, type ErrorCategory } from "@/lib/logger";

interface ErrorOpts {
  /** Module identifier for siso_logs/siso_erros (e.g. "wms.ajuste") */
  source: string;
  /** Caught error */
  error: unknown;
  /** Human-readable message para os logs */
  message?: string;
  /** Category pra siso_erros (defaults: 5xx=database, 4xx=business_logic) */
  category?: ErrorCategory;
  /** HTTP status do response (default 500) */
  status?: number;
  /** Path/method opcionais pra rastreamento */
  requestPath?: string;
  requestMethod?: string;
  /** Metadados extra */
  metadata?: Record<string, unknown>;
}

/**
 * Centraliza catch de routes API WMS:
 * - Loga erro completo via logger.logError (siso_logs + siso_erros)
 * - Retorna response com mensagem genérica em 5xx (não vaza Postgres
 *   error pro client), específica em 4xx
 *
 * Antes desse helper, cada route fazia:
 *   return NextResponse.json({ error: String(e) }, { status: 500 })
 * que vazava nomes de tabela, constraints, SQL completo pro browser.
 */
/**
 * Extrai mensagem de erro de:
 * - Error nativo (.message)
 * - PostgrestError do Supabase (objeto plain com .message — NÃO é Error instance)
 * - Qualquer outro objeto com .message: string
 * - Strings/numbers (String())
 *
 * Sem esse helper, PostgrestError caía em String(obj) e o client recebia
 * "[object Object]" em vez de "duplicate key value violates...".
 */
function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
  }
  return String(e);
}

export function wmsErrorResponse(opts: ErrorOpts): NextResponse {
  const status = opts.status ?? 500;
  const isClientError = status >= 400 && status < 500;
  const errMsg = extractErrorMessage(opts.error);

  logger.logError({
    error: opts.error,
    source: opts.source,
    message: opts.message ?? errMsg,
    category: opts.category ?? (isClientError ? "business_logic" : "database"),
    severity: isClientError ? "warning" : "error",
    requestPath: opts.requestPath,
    requestMethod: opts.requestMethod,
    metadata: opts.metadata,
  });

  // 4xx: cliente precisa saber o motivo (validação, regra de negócio).
  // 5xx: vazaria interno; devolve mensagem genérica.
  const clientMessage = isClientError ? errMsg : "internal_error";
  return NextResponse.json({ error: clientMessage }, { status });
}
