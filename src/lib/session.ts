import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { loadUserRolesAndPermissions } from "@/lib/roles-loader";

export interface SessionUser {
  id: string;
  nome: string;
  cargo: string;                  // mantido por compat — primeira role.codigo
  cargos: string[];               // mantido por compat — roles[].codigo
  roles: Array<{ id: string; codigo: string; nome: string }>;
  permissoes: Set<string>;        // união das permissões das roles ativas
  galpaoId: string | null;
}

/**
 * Validates a session ID from the X-Session-Id header and returns the
 * authenticated user with their resolved galpão.
 *
 * Galpão resolution priority:
 *   1. X-Galpao-Id header (new dynamic approach)
 *   2. Legacy cargo-based resolution (operador_cwb → CWB, operador_sp → SP)
 *
 * Returns null if session not found, expired, or user not found.
 */
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  const sessionId = request.headers.get("X-Session-Id");
  if (!sessionId) return null;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("siso_sessoes")
    .select("usuario_id, siso_usuarios(id, nome, cargo, cargos)")
    .eq("id", sessionId)
    .gt("expira_em", new Date().toISOString())
    .single();

  if (error || !data) {
    logger.warn("session", "Session not found or expired", { sessionId });
    return null;
  }

  const usuario = data.siso_usuarios as unknown as {
    id: string;
    nome: string;
    cargo: string;
    cargos: string[];
  } | null;

  if (!usuario) return null;

  const { roles: rolesAtivas, permissoes: permissoesSet } =
    await loadUserRolesAndPermissions(supabase, usuario, "session");

  const cargosOut = rolesAtivas.map((r) => r.codigo);
  const cargoOut = cargosOut[0] ?? usuario.cargo ?? "";

  // ── Galpão (lógica existente, sem mudanças funcionais) ──
  const galpaoIdHeader = request.headers.get("X-Galpao-Id");
  if (galpaoIdHeader) {
    const { data: valid } = await supabase
      .from("siso_usuario_galpoes")
      .select("galpao_id")
      .eq("usuario_id", usuario.id)
      .eq("galpao_id", galpaoIdHeader)
      .maybeSingle();

    if (valid) {
      return {
        id: usuario.id,
        nome: usuario.nome,
        cargo: cargoOut,
        cargos: cargosOut,
        roles: rolesAtivas,
        permissoes: permissoesSet,
        galpaoId: galpaoIdHeader,
      };
    }
  }

  let galpaoId: string | null = null;
  const operadorCargo = cargosOut.find((c) => c === "operador_cwb" || c === "operador_sp");
  if (operadorCargo) {
    const galpaoNome = operadorCargo === "operador_cwb" ? "CWB" : "SP";
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
    cargo: cargoOut,
    cargos: cargosOut,
    roles: rolesAtivas,
    permissoes: permissoesSet,
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
