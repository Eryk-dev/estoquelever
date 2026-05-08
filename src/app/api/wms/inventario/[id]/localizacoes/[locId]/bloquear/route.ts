import { NextRequest, NextResponse } from "next/server";
import { pegarLocalizacao, liberarLocalizacao } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; locId: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id, locId } = await params;
  try {
    await pegarLocalizacao(id, locId, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 409 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; locId: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id, locId } = await params;
  try {
    await liberarLocalizacao(id, locId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
