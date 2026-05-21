import { logger } from "@/lib/logger";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LoadedRole {
  id: string;
  codigo: string;
  nome: string;
}

export interface LoadedRolesResult {
  roles: LoadedRole[];
  permissoes: Set<string>;
}

interface UserShape {
  id: string;
  cargo: string | null;
  cargos: string[] | null;
}

/**
 * Carrega as roles ativas + união das permissões de um usuário.
 *
 * Caminho principal: lê `siso_usuario_roles` → `siso_roles` (ativos) →
 * `siso_role_permissoes`. Roles com `ativo=false` são silenciosamente
 * ignoradas (suporta soft-disable de roles sem desatribuir usuários).
 *
 * Fallback de compat: se o usuário não tem nenhuma row em
 * `siso_usuario_roles` ainda (cenário durante backfill ou inserção
 * legacy), busca `siso_roles` pelos códigos em `usuario.cargos[]` (ou
 * `usuario.cargo` como singular). O trigger `trg_sync_cargos_after_roles`
 * mantém `cargos[]` consistente em direção contrária; este fallback é
 * proteção defensiva.
 *
 * Erros são logados mas não propagados — chamador continua com permissões
 * vazias em vez de quebrar login/sessão. Isso evita lockout em caso de
 * falha transitória de RLS ou DB. A camada de UI e API mostra "sem acesso"
 * em vez de tela quebrada.
 *
 * @param source — usado no log de erros pra rastrear o origin do call site
 *                 (`"session"`, `"auth/login"`, `"auth/me"`, etc.)
 */
export async function loadUserRolesAndPermissions(
  supabase: SupabaseClient,
  usuario: UserShape,
  source: string,
): Promise<LoadedRolesResult> {
  const roles: LoadedRole[] = [];
  const permissoes = new Set<string>();

  // Caminho principal — siso_usuario_roles
  const { data: rolesRows, error: rolesError } = await supabase
    .from("siso_usuario_roles")
    .select("siso_roles(id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo))")
    .eq("usuario_id", usuario.id);

  if (rolesError) {
    logger.error(source, "Failed to load user roles", {
      usuarioId: usuario.id,
      error: rolesError.message,
    });
  }

  for (const row of rolesRows ?? []) {
    const r = (row as unknown as {
      siso_roles: {
        id: string;
        codigo: string;
        nome: string;
        ativo: boolean;
        siso_role_permissoes: Array<{ permissao_codigo: string }>;
      } | null;
    }).siso_roles;
    if (!r || !r.ativo) continue;
    roles.push({ id: r.id, codigo: r.codigo, nome: r.nome });
    for (const rp of r.siso_role_permissoes ?? []) permissoes.add(rp.permissao_codigo);
  }

  // Fallback — sem siso_usuario_roles, usa cargos[] como proxy
  if (roles.length === 0 && (usuario.cargos?.length || usuario.cargo)) {
    const codigos = usuario.cargos?.length ? usuario.cargos : [usuario.cargo!];
    const { data: fallback, error: fallbackError } = await supabase
      .from("siso_roles")
      .select("id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo)")
      .in("codigo", codigos);

    if (fallbackError) {
      logger.error(source, "Failed to load fallback roles by cargos[]", {
        usuarioId: usuario.id,
        cargos: codigos,
        error: fallbackError.message,
      });
    }

    for (const r of fallback ?? []) {
      if (!r.ativo) continue;
      roles.push({ id: r.id, codigo: r.codigo, nome: r.nome });
      const rps = (r as unknown as { siso_role_permissoes: Array<{ permissao_codigo: string }> })
        .siso_role_permissoes;
      for (const rp of rps ?? []) permissoes.add(rp.permissao_codigo);
    }
  }

  return { roles, permissoes };
}
