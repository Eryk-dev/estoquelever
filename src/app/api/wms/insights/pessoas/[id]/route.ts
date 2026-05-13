import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { getPessoaDetalhe } from "@/lib/wms/insights/queries";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const dias = Number(req.nextUrl.searchParams.get("dias") ?? 30);
  const sb = createServiceClient();
  const [usuario, serie] = await Promise.all([
    sb.from("siso_usuarios").select("id, nome, cargo, ativo").eq("id", id).single(),
    getPessoaDetalhe(id, dias),
  ]);
  if (usuario.error) {
    return NextResponse.json({ error: usuario.error.message }, { status: 404 });
  }
  return NextResponse.json({ usuario: usuario.data, serie });
}
