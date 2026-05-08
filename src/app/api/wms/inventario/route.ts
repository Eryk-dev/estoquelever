import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { criarSessaoInventario } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = createServiceClient();
  const sp = req.nextUrl.searchParams;
  let q = sb
    .from("siso_inventario_sessoes")
    .select(
      "*, galpao:siso_galpoes(nome), criada_por_user:siso_usuarios!siso_inventario_sessoes_criada_por_fkey(nome)",
    )
    .order("criado_em", { ascending: false })
    .limit(100);
  const status = sp.get("status");
  const galpaoId = sp.get("galpao_id");
  if (status) q = q.eq("status", status);
  if (galpaoId) q = q.eq("galpao_id", galpaoId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.tipo || !body.galpao_id || !Array.isArray(body.areas)) {
    return NextResponse.json(
      { error: "tipo, galpao_id, areas obrigatórios" },
      { status: 400 },
    );
  }
  try {
    const id = await criarSessaoInventario({ ...body, criada_por: user.id });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
