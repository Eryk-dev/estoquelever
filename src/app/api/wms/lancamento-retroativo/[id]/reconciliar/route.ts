import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { reconciliarRetroativo } from "@/lib/wms/movimentacoes";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  if (!body.compra_mov_id) {
    return NextResponse.json({ error: "compra_mov_id obrigatório" }, { status: 400 });
  }
  try {
    await reconciliarRetroativo({
      retroativo_mov_id: id,
      compra_mov_id: body.compra_mov_id,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
