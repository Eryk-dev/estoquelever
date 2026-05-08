import { NextRequest, NextResponse } from "next/server";
import { listarProdutos, criarProduto } from "@/lib/wms/produtos";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  try {
    const ativoParam = sp.get("ativo");
    const result = await listarProdutos({
      q: sp.get("q") ?? undefined,
      ativo: ativoParam === "false" ? false : ativoParam === "true" ? true : undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : 50,
      offset: sp.get("offset") ? Number(sp.get("offset")) : 0,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.sku || !body.descricao) {
    return NextResponse.json({ error: "sku e descricao obrigatórios" }, { status: 400 });
  }
  try {
    const produto = await criarProduto(body);
    return NextResponse.json(produto, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
