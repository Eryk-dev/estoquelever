import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export interface SessionUser {
  id: string;
  nome: string;
  cargo: string;
  galpaoId: string | null;
}

/**
 * Validates a session ID from the X-Session-Id header and returns the
 * authenticated user with their resolved galpão.
 *
 * Returns null if session not found, expired, or user not found.
 */
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  const sessionId = request.headers.get("X-Session-Id");
  if (!sessionId) return null;

  const supabase = createServiceClient();

  // Join sessoes → usuarios, filtering by valid (non-expired) session
  const { data, error } = await supabase
    .from("siso_sessoes")
    .select("usuario_id, siso_usuarios(id, nome, cargo)")
    .eq("id", sessionId)
    .gt("expira_em", new Date().toISOString())
    .single();

  if (error || !data) {
    logger.warn("session", "Session not found or expired", { sessionId });
    return null;
  }

  // Supabase returns the joined row as an object (single FK)
  const usuario = data.siso_usuarios as unknown as {
    id: string;
    nome: string;
    cargo: string;
  } | null;

  if (!usuario) return null;

  // Resolve galpaoId from cargo
  let galpaoId: string | null = null;

  if (usuario.cargo === "operador_cwb" || usuario.cargo === "operador_sp") {
    const galpaoNome = usuario.cargo === "operador_cwb" ? "CWB" : "SP";
    const { data: galpao } = await supabase
      .from("siso_galpoes")
      .select("id")
      .eq("nome", galpaoNome)
      .single();

    galpaoId = galpao?.id ?? null;
  }

  return {
    id: usuario.id,
    nome: usuario.nome,
    cargo: usuario.cargo,
    galpaoId,
  };
}

// ── Session-based rate limiter for bip endpoint ──

const BIP_MAX_PER_SECOND = 2;
const CLEANUP_INTERVAL = 100; // cleanup every N calls
const ENTRY_TTL_MS = 60_000; // remove entries older than 60s

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms
}

const bipLimits = new Map<string, RateLimitEntry>();
let bipCallCount = 0;

/**
 * Check if a bip request is allowed for the given sessionId.
 * Max 2 requests per second per session.
 */
export function checkBipRateLimit(sessionId: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const now = Date.now();

  // Periodic cleanup
  bipCallCount++;
  if (bipCallCount >= CLEANUP_INTERVAL) {
    bipCallCount = 0;
    for (const [key, entry] of bipLimits) {
      if (entry.resetAt < now - ENTRY_TTL_MS) {
        bipLimits.delete(key);
      }
    }
  }

  const entry = bipLimits.get(sessionId);

  // No entry or window expired — start new window
  if (!entry || now >= entry.resetAt) {
    bipLimits.set(sessionId, { count: 1, resetAt: now + 1000 });
    return { allowed: true };
  }

  // Within window — check count
  if (entry.count < BIP_MAX_PER_SECOND) {
    entry.count++;
    return { allowed: true };
  }

  // Rate limited
  return { allowed: false, retryAfterMs: entry.resetAt - now };
}
