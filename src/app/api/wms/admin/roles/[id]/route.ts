import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

interface Ctx { params: Promise<{ id: string }> }

async function authz(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return { error: NextResponse.json({ error: "Não autenticado" }, { status: 401 }) };
  }
  if (!userCan(session, "sistema.roles")) {
    return { error: NextResponse.json({ error: "Acesso negado" }, { status: 403 }) };
  }
  return { session };
}

/**
 * GET /api/wms/admin/roles/[id]
 * Detalhe da role: meta + array de códigos de permissões + usuários atribuídos
 * (cada um com lista de outras roles que tem).
 * Auth: sistema.roles
 */
export async function GET(request: Request, ctx: Ctx) {
  const a = await authz(request);
  if (a.error) return a.error;
  const { id } = await ctx.params;
  const sb = createServiceClient();

  const [{ data: role, error: re }, { data: perms }, { data: usuariosRows }] = await Promise.all([
    sb
      .from("siso_roles")
      .select("id, codigo, nome, descricao, sistema, ativo, criado_em, atualizado_em")
      .eq("id", id)
      .maybeSingle(),
    sb.from("siso_role_permissoes").select("permissao_codigo").eq("role_id", id),
    sb
      .from("siso_usuario_roles")
      .select("siso_usuarios(id, nome, cargos)")
      .eq("role_id", id),
  ]);

  if (re) return NextResponse.json({ error: re.message }, { status: 500 });
  if (!role) return NextResponse.json({ error: "Role não encontrada" }, { status: 404 });

  const usuarios = (usuariosRows ?? [])
    .map((row) => {
      const u = (row as unknown as {
        siso_usuarios: { id: string; nome: string; cargos: string[] } | null;
      }).siso_usuarios;
      return u ? { id: u.id, nome: u.nome, roles: u.cargos ?? [] } : null;
    })
    .filter((u): u is { id: string; nome: string; roles: string[] } => u !== null);

  return NextResponse.json({
    role: {
      ...role,
      permissoes: (perms ?? []).map((p) => p.permissao_codigo),
      usuarios,
    },
  });
}

/**
 * PATCH /api/wms/admin/roles/[id]
 * Body: { nome?, descricao?, ativo? }
 * Edita meta da role. Role sistema NÃO pode ser desativada (mas pode ter
 * nome/descricao editados).
 * Auth: sistema.roles
 */
export async function PATCH(request: Request, ctx: Ctx) {
  const a = await authz(request);
  if (a.error) return a.error;
  const { id } = await ctx.params;

  let body: { nome?: string; descricao?: string | null; ativo?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data: existing } = await sb
    .from("siso_roles")
    .select("codigo, sistema")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Role não encontrada" }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  if (typeof body.nome === "string" && body.nome.trim()) update.nome = body.nome.trim();
  if (body.descricao !== undefined) {
    update.descricao = body.descricao?.toString().trim() || null;
  }
  if (typeof body.ativo === "boolean") {
    if (existing.sistema && body.ativo === false) {
      return NextResponse.json(
        { error: "Role de sistema não pode ser desativada" },
        { status: 400 },
      );
    }
    update.ativo = body.ativo;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await sb
    .from("siso_roles")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ role: data });
}

/**
 * DELETE /api/wms/admin/roles/[id]
 * Delega pra RPC wms_role_delete que valida:
 * - Role não é sistema
 * - Nenhum usuário ficaria sem role após o delete
 * Auth: sistema.roles
 */
export async function DELETE(request: Request, ctx: Ctx) {
  const a = await authz(request);
  if (a.error) return a.error;
  const { id } = await ctx.params;

  const sb = createServiceClient();
  const { error } = await sb.rpc("wms_role_delete", { p_role_id: id });
  if (error) {
    const status = /sistema|admin|sem nenhuma role/i.test(error.message) ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ ok: true });
}
