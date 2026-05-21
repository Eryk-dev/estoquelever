import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

interface Ctx { params: Promise<{ id: string }> }

/**
 * PUT /api/wms/admin/usuarios/[id]/roles
 * Body: { role_ids: string[] }   ← replace completo das roles do usuário
 *
 * Regras:
 * - Todas role_ids devem existir em siso_roles.
 * - role_ids vazio é PERMITIDO (mas usuário fica sem acesso — UI mostra
 *   aviso claro). Útil pra desativar acesso sem deletar o usuário.
 * - Anti-lockout: se este usuário tinha role admin E perderia (não está
 *   em role_ids) E não há outro usuário com role admin → bloqueia.
 *
 * Auth: sistema.usuarios
 */
export async function PUT(request: Request, ctx: Ctx) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: usuarioId } = await ctx.params;
  let body: { role_ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!Array.isArray(body.role_ids)) {
    return NextResponse.json({ error: "role_ids deve ser array" }, { status: 400 });
  }

  const sb = createServiceClient();

  // Validar IDs existentes
  const safeIds = body.role_ids.length
    ? body.role_ids
    : ["00000000-0000-0000-0000-000000000000"];
  const { data: existingRoles } = await sb
    .from("siso_roles")
    .select("id, codigo")
    .in("id", safeIds);

  if ((existingRoles?.length ?? 0) !== body.role_ids.length) {
    return NextResponse.json({ error: "Uma ou mais roles não existem" }, { status: 400 });
  }

  // Anti-lockout: se novas roles NÃO incluem 'admin', mas o usuário ERA admin,
  // verifica se existe outro admin no sistema.
  const newCodigos = new Set((existingRoles ?? []).map((r) => r.codigo));
  if (!newCodigos.has("admin")) {
    // O usuário era admin?
    const { data: eraAdmin } = await sb
      .from("siso_usuario_roles")
      .select("usuario_id, siso_roles!inner(codigo)")
      .eq("usuario_id", usuarioId)
      .eq("siso_roles.codigo", "admin")
      .maybeSingle();

    if (eraAdmin) {
      // Existe outro admin?
      const { data: outrosAdmins } = await sb
        .from("siso_usuario_roles")
        .select("usuario_id, siso_roles!inner(codigo)")
        .eq("siso_roles.codigo", "admin")
        .neq("usuario_id", usuarioId);

      if (!outrosAdmins || outrosAdmins.length === 0) {
        return NextResponse.json(
          { error: "Sistema precisa de pelo menos 1 admin" },
          { status: 400 },
        );
      }
    }
  }

  // Replace: delete + insert
  const { error: delErr } = await sb
    .from("siso_usuario_roles")
    .delete()
    .eq("usuario_id", usuarioId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  if (body.role_ids.length > 0) {
    const rows = body.role_ids.map((rid) => ({ usuario_id: usuarioId, role_id: rid }));
    const { error: insErr } = await sb.from("siso_usuario_roles").insert(rows);
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, role_ids: body.role_ids });
}
