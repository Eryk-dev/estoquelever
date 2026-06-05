import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan, PERMISSAO_CODIGOS } from "@/lib/permissions";

interface Ctx { params: Promise<{ id: string }> }

/**
 * PUT /api/wms/admin/roles/[id]/permissoes
 * Body: { permissoes: string[] }   ← replace completo
 *
 * Regras:
 * - Role 'admin' sempre tem TODAS as permissões — payload é ignorado e o
 *   sistema força o set completo (idempotente, mantém a invariante).
 * - Códigos não-existentes no registry são rejeitados (400) com lista.
 * - Replace atômico via RPC wms_set_role_permissoes: delete+insert numa só
 *   transação, sob SELECT ... FOR UPDATE do role (serializa edições
 *   concorrentes). Tudo-ou-nada — falha em qualquer ponto → rollback total,
 *   o conjunto de permissões anterior permanece intacto (P138/P139).
 *
 * Auth: sistema.roles
 */
export async function PUT(request: Request, ctx: Ctx) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.roles")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id } = await ctx.params;
  let body: { permissoes?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!Array.isArray(body.permissoes)) {
    return NextResponse.json({ error: "permissoes deve ser array" }, { status: 400 });
  }

  const validSet = new Set<string>(PERMISSAO_CODIGOS);
  const invalidos = body.permissoes.filter((p) => !validSet.has(p));
  if (invalidos.length > 0) {
    return NextResponse.json(
      { error: "Permissões inválidas", invalidos },
      { status: 400 },
    );
  }

  const sb = createServiceClient();
  const { data: role } = await sb
    .from("siso_roles")
    .select("codigo")
    .eq("id", id)
    .maybeSingle();
  if (!role) {
    return NextResponse.json({ error: "Role não encontrada" }, { status: 404 });
  }

  // admin sempre tem TODAS — ignora payload, força set completo
  const finalSet: string[] = role.codigo === "admin"
    ? [...PERMISSAO_CODIGOS]
    : Array.from(new Set(body.permissoes));

  // P138/P139: replace atômico + serializado na RPC (delete+insert numa só
  // transação, sob FOR UPDATE do role). Substitui o delete+insert client-side.
  const { data: total, error: rpcErr } = await sb.rpc("wms_set_role_permissoes", {
    p_role_id: id,
    p_codigos: finalSet,
  });
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, total: total ?? finalSet.length });
}
