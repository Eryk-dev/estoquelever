import { NextRequest, NextResponse } from "next/server";
import {
  listarProdutoFornecedores,
  vincularProdutoFornecedor,
} from "@/lib/wms/fornecedores";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const produtoId = req.nextUrl.searchParams.get("produto_id");
  if (!produtoId) {
    return NextResponse.json({ error: "produto_id obrigatório" }, { status: 400 });
  }
  return NextResponse.json({ rows: await listarProdutoFornecedores(produtoId) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  try {
    return NextResponse.json(await vincularProdutoFornecedor(body), {
      status: 201,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
