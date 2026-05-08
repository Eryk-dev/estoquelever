import { NextRequest, NextResponse } from "next/server";
import { listarProdutos, criarProduto } from "@/lib/wms/produtos";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

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
    return wmsErrorResponse({
      source: "wms.produtos",
      error: e,
      requestPath: "/api/wms/produtos",
      requestMethod: "GET",
    });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.sku || !body.descricao) {
    return NextResponse.json({ error: "sku e descricao obrigatórios" }, { status: 400 });
  }
  try {
    const produto = await criarProduto(body);
    return NextResponse.json(produto, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.criar",
      error: e,
      requestPath: "/api/wms/produtos",
      requestMethod: "POST",
      metadata: { sku: body.sku },
    });
  }
}
