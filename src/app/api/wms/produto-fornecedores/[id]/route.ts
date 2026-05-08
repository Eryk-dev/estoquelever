import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json();
  const sb = createServiceClient();
  if (body.preferencial === true) {
    const { data: pf } = await sb
      .from("siso_produto_fornecedores")
      .select("produto_id")
      .eq("id", id)
      .single();
    if (pf) {
      await sb
        .from("siso_produto_fornecedores")
        .update({ preferencial: false })
        .eq("produto_id", pf.produto_id);
    }
  }
  const { data, error } = await sb
    .from("siso_produto_fornecedores")
    .update({ ...body, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sb = createServiceClient();
  await sb.from("siso_produto_fornecedores").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
