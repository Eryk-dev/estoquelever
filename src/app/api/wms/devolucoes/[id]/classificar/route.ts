import { NextRequest, NextResponse } from "next/server";
import { classificarDevolucao } from "@/lib/wms/devolucoes";
import { requireWarehouseAccess } from "@/lib/wms/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  try {
    await classificarDevolucao({
      ...body,
      devolucao_id: id,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
