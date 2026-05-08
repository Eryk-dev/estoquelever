import { NextRequest, NextResponse } from "next/server";
import { listarFornecedores, criarFornecedor } from "@/lib/wms/fornecedores";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ rows: await listarFornecedores() });
}

export async function POST(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  if (!body.nome) {
    return NextResponse.json({ error: "nome obrigatório" }, { status: 400 });
  }
  try {
    return NextResponse.json(await criarFornecedor(body), { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
