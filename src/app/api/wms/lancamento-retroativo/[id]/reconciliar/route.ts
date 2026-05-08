import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { reconciliarRetroativo } from "@/lib/wms/movimentacoes";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  if (!body.compra_mov_id) {
    return NextResponse.json({ error: "compra_mov_id obrigatório" }, { status: 400 });
  }
  try {
    await reconciliarRetroativo({
      retroativo_mov_id: id,
      compra_mov_id: body.compra_mov_id,
      usuario_id: user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
