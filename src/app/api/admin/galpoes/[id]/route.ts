import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * PUT /api/admin/galpoes/[id]
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { nome, descricao, ativo, printnode_printer_id, printnode_printer_nome } = body;

  const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if (nome !== undefined) update.nome = nome.trim();
  if (descricao !== undefined) update.descricao = descricao?.trim() || null;
  if (ativo !== undefined) update.ativo = ativo;
  if (printnode_printer_id !== undefined) update.printnode_printer_id = printnode_printer_id;
  if (printnode_printer_nome !== undefined) update.printnode_printer_nome = printnode_printer_nome;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_galpoes")
    .update(update)
    .eq("id", id)
    .select("id, nome, ativo")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Nome já existe" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
