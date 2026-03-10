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
