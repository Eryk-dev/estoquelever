import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { ajustarEstoque } from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  try {
    await ajustarEstoque({ ...body, usuario_id: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
