/**
 * Structured logger for SISO.
 *
 * Writes to both:
 * - stdout (structured JSON, consumed by Easypanel log aggregation)
 * - Supabase siso_logs table (fire-and-forget, never blocks)
 *
 * For errors, additionally writes to siso_erros with rich diagnostics
 * (stack traces, categories, correlation IDs, resolution tracking).
 *
 * The module itself never throws — all internal errors are swallowed so that
 * a logging failure cannot break request handling.
 */

import { createServiceClient } from "@/lib/supabase-server";

type Level = "info" | "warn" | "error";

export interface LogOptions {
  pedidoId?: string;
  filial?: string;
  [key: string]: unknown;
}

/** Error categories for siso_erros */
export type ErrorCategory =
  | "validation"
  | "database"
  | "external_api"
  | "auth"
  | "config"
  | "business_logic"
  | "infrastructure"
  | "unknown";

export type ErrorSeverity = "warning" | "error" | "critical";

/** Options for the structured error logger */
export interface ErrorLogOptions {
  /** Error or thrown value */
  error: unknown;
  /** Module that produced the error (e.g., 'webhook', 'worker') */
  source: string;
  /** Human-readable message */
  message: string;
  /** Error classification */
  category?: ErrorCategory;
  /** Severity level */
  severity?: ErrorSeverity;
  /** Order ID (Tiny pedido ID) */
  pedidoId?: string;
  /** Empresa UUID */
  empresaId?: string;
  /** Empresa display name */
  empresaNome?: string;
  /** Galpao name (CWB, SP) */
  galpaoNome?: string;
  /** Correlation ID to trace multi-step operations */
  correlationId?: string;
  /** HTTP request path */
  requestPath?: string;
  /** HTTP method */
  requestMethod?: string;
  /** Structured error code (e.g., '23505', 'RATE_LIMITED', 'TOKEN_EXPIRED') */
  errorCode?: string;
  /** Arbitrary extra context */
  metadata?: Record<string, unknown>;
}

// ─── Correlation ID ──────────────────────────────────────────────────────────

let _correlationId: string | undefined;

/** Generate a new correlation ID (call at the start of a request/webhook) */
export function generateCorrelationId(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  _correlationId = id;
  return id;
}

/** Get the current correlation ID (set by generateCorrelationId) */
export function getCorrelationId(): string | undefined {
  return _correlationId;
}

/** Set the correlation ID explicitly (e.g., from a header) */
export function setCorrelationId(id: string): void {
  _correlationId = id;
}

// ─── Error serialization ─────────────────────────────────────────────────────

/** Extract error message from any thrown value */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/** Extract stack trace from an Error, or create one */
function extractStack(err: unknown): string | null {
  if (err instanceof Error && err.stack) return err.stack;
  // Create a stack trace at the call site if none available
  try {
    const syntheticErr = new Error("(synthetic stack)");
    // Remove the first 3 lines (Error, extractStack, logError)
    const lines = syntheticErr.stack?.split("\n") ?? [];
    return lines.slice(3).join("\n") || null;
  } catch {
    return null;
  }
}

/** Try to extract a structured error code from the error */
function extractErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null) {
    // Supabase errors have .code
    if ("code" in err && typeof (err as { code: unknown }).code === "string") {
      return (err as { code: string }).code;
    }
    // HTTP-like errors
    if ("status" in err && typeof (err as { status: unknown }).status === "number") {
      return `HTTP_${(err as { status: number }).status}`;
    }
  }
  return null;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function writeToConsole(
  level: Level,
  source: string,
  message: string,
  meta: LogOptions,
): void {
  const { pedidoId, filial, ...rest } = meta;
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
  };
  if (pedidoId !== undefined) entry.pedido_id = pedidoId;
  if (filial !== undefined) entry.filial = filial;
  if (_correlationId) entry.correlation_id = _correlationId;
  if (Object.keys(rest).length > 0) entry.metadata = rest;

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function persistToSupabase(
  level: Level,
  source: string,
  message: string,
  meta: LogOptions,
): void {
  // Fire-and-forget — no await, no blocking
  try {
    const { pedidoId, filial, ...rest } = meta;
    const supabase = createServiceClient();

    // Wrap in Promise.resolve so we always get a real Promise for .catch()
    Promise.resolve(
      supabase
        .from("siso_logs")
        .insert({
          level,
          source,
          message,
          pedido_id: pedidoId ?? null,
          filial: filial ?? null,
          metadata: Object.keys(rest).length > 0 ? rest : {},
        }),
    )
      .then(({ error }) => {
        if (error) {
          console.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "error",
              source: "logger",
              message: "Failed to persist log to Supabase",
              metadata: { originalLevel: level, originalSource: source, supabaseError: error.message },
            }),
          );
        }
      })
      .catch((err: unknown) => {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            source: "logger",
            message: "Unexpected error persisting log",
            metadata: { error: err instanceof Error ? err.message : String(err) },
          }),
        );
      });
  } catch {
    // createServiceClient() itself failed — swallow silently
  }
}

/** Persist a structured error to siso_erros (fire-and-forget) */
function persistErrorToSupabase(opts: ErrorLogOptions): void {
  try {
    const supabase = createServiceClient();
    const errorMsg = extractErrorMessage(opts.error);
    const stack = extractStack(opts.error);
    const autoCode = extractErrorCode(opts.error);

    Promise.resolve(
      supabase.from("siso_erros").insert({
        source: opts.source,
        category: opts.category ?? "unknown",
        severity: opts.severity ?? "error",
        message: opts.message,
        stack_trace: stack,
        error_code: opts.errorCode ?? autoCode,
        pedido_id: opts.pedidoId ?? null,
        empresa_id: opts.empresaId ?? null,
        empresa_nome: opts.empresaNome ?? null,
        galpao_nome: opts.galpaoNome ?? null,
        correlation_id: opts.correlationId ?? _correlationId ?? null,
        request_path: opts.requestPath ?? null,
        request_method: opts.requestMethod ?? null,
        metadata: {
          error_message: errorMsg,
          ...(opts.metadata ?? {}),
        },
      }),
    )
      .then(({ error }) => {
        if (error) {
          console.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "error",
              source: "logger",
              message: "Failed to persist error to siso_erros",
              metadata: { supabaseError: error.message, originalSource: opts.source },
            }),
          );
        }
      })
      .catch((err: unknown) => {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            source: "logger",
            message: "Unexpected error persisting to siso_erros",
            metadata: { error: err instanceof Error ? err.message : String(err) },
          }),
        );
      });
  } catch {
    // Swallow — logger must never crash
  }
}

function log(
  level: Level,
  source: string,
  message: string,
  meta: LogOptions = {},
): void {
  try {
    writeToConsole(level, source, message, meta);
    persistToSupabase(level, source, message, meta);
  } catch {
    // Absolute last resort — logger must never crash the caller
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const logger = {
  info(source: string, message: string, meta?: LogOptions): void {
    log("info", source, message, meta);
  },
  warn(source: string, message: string, meta?: LogOptions): void {
    log("warn", source, message, meta);
  },
  error(source: string, message: string, meta?: LogOptions): void {
    log("error", source, message, meta);
  },

  /**
   * Log a structured error to both siso_logs and siso_erros.
   *
   * Use this instead of logger.error() when you have an actual Error object
   * and want rich diagnostics (stack trace, category, correlation, etc).
   *
   * @example
   * ```ts
   * logger.logError({
   *   error: err,
   *   source: "worker",
   *   message: "Job failed",
   *   category: "external_api",
   *   pedidoId: "123",
   *   empresaId: "abc-uuid",
   *   metadata: { jobId: "xyz", tentativas: 3 },
   * });
   * ```
   */
  logError(opts: ErrorLogOptions): void {
    try {
      const errorMsg = extractErrorMessage(opts.error);

      // Write to siso_logs (backwards compat)
      log(opts.severity === "warning" ? "warn" : "error", opts.source, opts.message, {
        pedidoId: opts.pedidoId,
        error: errorMsg,
        category: opts.category,
        correlationId: opts.correlationId ?? _correlationId,
        ...(opts.metadata ?? {}),
      });

      // Write to siso_erros (rich structure)
      persistErrorToSupabase(opts);
    } catch {
      // Never crash
    }
  },
};
