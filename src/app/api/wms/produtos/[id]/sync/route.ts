import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { sincronizarProduto } from "@/lib/wms/sync-tiny";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await sincronizarProduto(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
