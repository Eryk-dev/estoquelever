import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { clearEmpresaCache } from "@/lib/empresa-lookup";

/**
 * PUT /api/admin/empresas/[id]
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { nome, galpao_id, ativo } = body;

  const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if (nome !== undefined) update.nome = nome.trim();
  if (galpao_id !== undefined) update.galpao_id = galpao_id;
  if (ativo !== undefined) update.ativo = ativo;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_empresas")
    .update(update)
    .eq("id", id)
    .select("id, nome, galpao_id, ativo")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  clearEmpresaCache();
  return NextResponse.json(data);
}
