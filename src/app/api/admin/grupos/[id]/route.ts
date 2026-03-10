import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

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

  return NextResponse.json(data);
}
