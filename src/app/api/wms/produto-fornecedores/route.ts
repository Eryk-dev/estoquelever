import { NextRequest, NextResponse } from "next/server";
import {
  listarProdutoFornecedores,
  vincularProdutoFornecedor,
} from "@/lib/wms/fornecedores";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const produtoId = req.nextUrl.searchParams.get("produto_id");
  if (!produtoId) {
    return NextResponse.json({ error: "produto_id obrigatório" }, { status: 400 });
  }
  return NextResponse.json({ rows: await listarProdutoFornecedores(produtoId) });
}

export async function POST(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  try {
    return NextResponse.json(await vincularProdutoFornecedor(body), {
      status: 201,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
