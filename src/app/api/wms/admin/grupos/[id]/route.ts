import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { clearGrupoCache } from "@/lib/grupo-resolver";

/**
 * PUT /api/admin/grupos/[id]
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { nome, descricao } = body;

  const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if (nome !== undefined) update.nome = nome.trim();
  if (descricao !== undefined) update.descricao = descricao?.trim() || null;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_grupos")
    .update(update)
    .eq("id", id)
    .select("id, nome")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  clearGrupoCache();
  return NextResponse.json(data);
}

/**
 * DELETE /api/admin/grupos/[id]
 * Remove grupo. Falha se ainda houver empresas vinculadas.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = createServiceClient();
  const { count, error: countErr } = await supabase
    .from("siso_grupo_empresas")
    .select("id", { count: "exact", head: true })
    .eq("grupo_id", id);

  if (countErr) {
    return NextResponse.json({ error: countErr.message }, { status: 500 });
  }
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: "Remova todas as empresas do grupo antes de excluí-lo" },
      { status: 409 },
    );
  }

  const { error } = await supabase.from("siso_grupos").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  clearGrupoCache();
  return NextResponse.json({ ok: true });
}
