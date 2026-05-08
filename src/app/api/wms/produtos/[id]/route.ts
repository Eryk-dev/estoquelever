import { NextRequest, NextResponse } from "next/server";
import { getProduto, atualizarProduto } from "@/lib/wms/produtos";
import { getSessionUser } from "@/lib/session";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const p = await getProduto(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(p);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  try {
    const p = await atualizarProduto(id, body);
    return NextResponse.json(p);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
