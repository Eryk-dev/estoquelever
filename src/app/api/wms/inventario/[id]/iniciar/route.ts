import { NextRequest, NextResponse } from "next/server";
import { iniciarSessao } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await iniciarSessao(id, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
