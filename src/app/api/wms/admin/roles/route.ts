import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

const CODIGO_RE = /^[a-z][a-z0-9_]*$/;

/**
 * GET /api/wms/admin/roles
 * Lista todas as roles + counts (n_permissoes, n_usuarios). Ordena
 * roles sistema primeiro (cadeado no UI), depois alfabético por nome.
 * Auth: sistema.roles
 */
export async function GET(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.roles")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_roles")
    .select("id, codigo, nome, descricao, sistema, ativo, criado_em, atualizado_em")
    .order("sistema", { ascending: false })
    .order("nome");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Counts por role
  const ids = (data ?? []).map((r) => r.id);
  const safeIds = ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
  const [{ data: perms }, { data: usuarios }] = await Promise.all([
    sb.from("siso_role_permissoes").select("role_id").in("role_id", safeIds),
    sb.from("siso_usuario_roles").select("role_id").in("role_id", safeIds),
  ]);

  const permsByRole = new Map<string, number>();
  for (const p of perms ?? []) permsByRole.set(p.role_id, (permsByRole.get(p.role_id) ?? 0) + 1);
  const usersByRole = new Map<string, number>();
  for (const u of usuarios ?? []) usersByRole.set(u.role_id, (usersByRole.get(u.role_id) ?? 0) + 1);

  const roles = (data ?? []).map((r) => ({
    ...r,
    n_permissoes: permsByRole.get(r.id) ?? 0,
    n_usuarios: usersByRole.get(r.id) ?? 0,
  }));

  return NextResponse.json({ roles });
}

/**
 * POST /api/wms/admin/roles
 * Body: { codigo: string, nome: string, descricao?: string }
 * Cria nova role com sistema=false, ativo=true e zero permissões. Admin
 * marca permissões depois via PUT /api/wms/admin/roles/[id]/permissoes.
 * - codigo: deve casar /^[a-z][a-z0-9_]*$/ (kebab/snake-case ASCII)
 * - 409 se codigo já existe
 * Auth: sistema.roles
 */
export async function POST(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.roles")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  let body: { codigo?: string; nome?: string; descricao?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const codigo = (body.codigo ?? "").trim();
  const nome = (body.nome ?? "").trim();
  const descricao = (body.descricao ?? "").trim() || null;

  if (!codigo || !CODIGO_RE.test(codigo)) {
    return NextResponse.json(
      { error: "Código inválido (use [a-z][a-z0-9_]*)" },
      { status: 400 },
    );
  }
  if (!nome) {
    return NextResponse.json({ error: "Nome obrigatório" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_roles")
    .insert({ codigo, nome, descricao, sistema: false, ativo: true })
    .select("id, codigo, nome, descricao, sistema, ativo, criado_em")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Código já existe" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ role: data }, { status: 201 });
}
