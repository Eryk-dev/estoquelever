import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/session";
import { userCan, userCanAny } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";

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
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !user.galpaoPodeEditar) {
    return {
      ok: false,
      response: forbidden("galpão disponível somente para visualização"),
    };
  }
  return { ok: true, user };
}

/**
 * Auth gate composto pra ações no pedido de venda manual:
 *  - PASS se: admin OR qualquer warehouse perm OR vendedor dono do pedido
 *  - FAIL caso contrário (403)
 *
 * "Dono" = vendedor_id == session.id OR vendedor_nome contém session.nome
 * (case-insensitive — cobre auto-atribuição ML/Shopee onde vendedor_nome
 * é `${ecomNome} ${empresaNome}` sem vendedor_id, ver vendas/[id]/route.ts:62-65).
 *
 * Use em endpoints de mutação do pedido onde o vendedor "puro" precisa
 * agir sobre o próprio pedido (cancelar, editar observação, etc).
 *
 * Pedido_id é validado: 404 se não existe; 403 se não é venda direta
 * (manual, ML ou Shopee).
 */
export async function requireWarehouseAccessOrOwnVenda(
  req: Request,
  pedidoId: string,
): Promise<AuthResult> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: unauthorized() };

  // Fast-path: admin OR warehouse passa sem ler DB
  const hasWarehouse = userCanAny(
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
  if (hasWarehouse) return { ok: true, user };

  // Slow-path: vendedor verifica ownership do pedido
  if (!userCan(user, "vendas.criar")) {
    return {
      ok: false,
      response: forbidden("requer admin/operador ou vendedor dono"),
    };
  }

  const sb = createServiceClient();
  const { data: pedido, error } = await sb
    .from("siso_pedidos")
    .select("id, vendedor_id, vendedor_nome, origem_pedido, nome_ecommerce")
    .eq("id", pedidoId)
    .maybeSingle();
  if (error || !pedido) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "pedido não encontrado" },
        { status: 404 },
      ),
    };
  }

  const isVendaDireta =
    pedido.origem_pedido === "manual" ||
    pedido.nome_ecommerce === "Mercado Livre" ||
    pedido.nome_ecommerce === "Shopee";
  if (!isVendaDireta) {
    return { ok: false, response: forbidden("ação restrita a vendas diretas") };
  }

  const ownedById = pedido.vendedor_id === user.id;
  const ownedByName = pedido.vendedor_nome
    ? pedido.vendedor_nome.toLowerCase().includes(user.nome.toLowerCase())
    : false;
  if (!ownedById && !ownedByName) {
    return { ok: false, response: forbidden("não é seu pedido") };
  }

  return { ok: true, user };
}
