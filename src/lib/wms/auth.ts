import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/session";

type AuthResult =
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse };

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function forbidden(motivo: string): NextResponse {
  return NextResponse.json({ error: motivo }, { status: 403 });
}

function isAdmin(user: SessionUser): boolean {
  const cargos = user.cargos?.length ? user.cargos : [user.cargo];
  return cargos.includes("admin");
}

function isOperator(user: SessionUser): boolean {
  const cargos = user.cargos?.length ? user.cargos : [user.cargo];
  return cargos.some((c) => c === "operador_cwb" || c === "operador_sp");
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
 * (snapshot inicial, auto-cadastro de fornecedores, gerenciamento de
 * regras de empréstimo, mass updates, etc).
 *
 * Checks the cargos[] array — não confunde com user.cargo (que é só o
 * primeiro). Operador que ALSO tem admin no cargos[] passa.
 */
export async function requireAdmin(req: Request): Promise<AuthResult> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: unauthorized() };
  if (!isAdmin(user))
    return { ok: false, response: forbidden("admin only") };
  return { ok: true, user };
}

/**
 * Acesso a operações de armazém: admin OU operador (CWB/SP).
 *
 * Comprador NÃO tem acesso por design — comprador trabalha em pedidos
 * de compra (siso_ordens_compra), não em movimentação física de estoque
 * do WMS.
 *
 * Use em endpoints que mutam siso_estoque/siso_movimentacoes (ajuste,
 * transferir-galpao, replenishment, lancamento-retroativo,
 * inventario, devoluções, etc).
 */
export async function requireWarehouseAccess(
  req: Request,
): Promise<AuthResult> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: unauthorized() };
  if (!isAdmin(user) && !isOperator(user)) {
    return {
      ok: false,
      response: forbidden("requer admin ou operador de galpão"),
    };
  }
  return { ok: true, user };
}
