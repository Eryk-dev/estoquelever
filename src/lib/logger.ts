/**
 * Structured logger for SISO.
 *
 * Writes to both:
 * - stdout (structured JSON, consumed by Easypanel log aggregation)
 * - Supabase siso_logs table (fire-and-forget, never blocks)
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
          // Use raw console to avoid recursive logger calls
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
    // createServiceClient() itself failed (e.g., missing env vars in test env)
    // Swallow silently — console already has the entry
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
};
