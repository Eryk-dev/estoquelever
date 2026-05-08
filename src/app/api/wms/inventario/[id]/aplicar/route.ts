import { NextRequest, NextResponse } from "next/server";
import { aplicarSessao } from "@/lib/wms/inventario";
import { getSessionUser } from "@/lib/session";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const r = await aplicarSessao(id, user.id);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
