import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/session";
import { userCan, userCanAny } from "@/lib/permissions";

type AuthResult =
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse };

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function forbidden(motivo: string): NextResponse {
  return NextResponse.json({ error: motivo }, { status: 403 });
}

/**
 * Authentication only — any logged-in user with valid session.
 * Use for read endpoints.
 */
export async function requireAuth(req: Request): Promise<AuthResult> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: unauthorized() };
  return { ok: true, user };
}

/**
 * Admin-only access. Used for destructive or system-level operations
 * (snapshot inicial, auto-cadastro de fornecedores, mass updates, etc).
 *
 * Migrado para RBAC dinâmico (2026-05-21): checa "sistema.usuarios" como
 * proxy "admin-equivalent" — a única permissão que apenas admin tem por
 * default. Mantém o gate idêntico ao comportamento legacy `cargos.includes("admin")`,
 * mas agora admin pode delegar abrindo um role customizado com essa perm.
 */
export async function requireAdmin(req: Request): Promise<AuthResult> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: unauthorized() };
  if (!userCan(user, "sistema.usuarios")) {
    return { ok: false, response: forbidden("admin only") };
  }
  return { ok: true, user };
}

/**
 * Acesso a operações de armazém. Originalmente "admin OU operador (CWB/SP)";
 * agora "tem QUALQUER permissão de operação física do armazém".
 *
 * Comprador continua SEM acesso (não tem nenhuma dessas perms no seed).
 * Vendedor continua SEM acesso.
 *
 * Use em endpoints que mutam siso_estoque/siso_movimentacoes (ajuste,
 * transferir-galpao, replenishment, lancamento-retroativo, inventario,
 * devoluções, etc).
 *
 * Migrado para RBAC dinâmico (2026-05-21): checa pelo conjunto de perms
 * de operações + inventário (executar/supervisionar) + cadastros. Custom
 * roles que tenham qualquer dessas têm acesso. Mantém comportamento idêntico
 * pras 6 roles sistema.
 */
export async function requireWarehouseAccess(
  req: Request,
): Promise<AuthResult> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: unauthorized() };
  const allowed = userCanAny(
    user,
    "operacoes.transferir",
    "operacoes.replenishment",
    "operacoes.devolucoes",
    "operacoes.receber",
    "operacoes.guarda",
    "operacoes.ajuste_manual",
    "inventario.executar",
    "inventario.supervisionar",
    "produtos.editar",
    "localizacoes.editar",
    "fornecedores.editar",
  );
  if (!allowed) {
    return {
      ok: false,
      response: forbidden("requer admin ou operador de galpão"),
    };
  }
  return { ok: true, user };
}
