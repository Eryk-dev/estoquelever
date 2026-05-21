import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { clearGrupoCache } from "@/lib/grupo-resolver";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * PUT /api/admin/grupos/[id]/empresas/[empresaId]
 * Update tier for an empresa in a grupo.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; empresaId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: grupoId, empresaId } = await params;
  const body = await request.json();
  const { tier } = body;

  if (!tier || tier < 1) {
    return NextResponse.json({ error: "tier deve ser >= 1" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_grupo_empresas")
    .update({ tier })
    .eq("grupo_id", grupoId)
    .eq("empresa_id", empresaId)
    .select("id, tier")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  clearGrupoCache();
  return NextResponse.json(data);
}

/**
 * DELETE /api/admin/grupos/[id]/empresas/[empresaId]
 * Remove empresa from grupo.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; empresaId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: grupoId, empresaId } = await params;

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("siso_grupo_empresas")
    .delete()
    .eq("grupo_id", grupoId)
    .eq("empresa_id", empresaId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  clearGrupoCache();
  return NextResponse.json({ ok: true });
}
