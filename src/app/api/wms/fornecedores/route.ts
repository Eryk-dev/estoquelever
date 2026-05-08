import { NextRequest, NextResponse } from "next/server";
import { listarFornecedores, criarFornecedor } from "@/lib/wms/fornecedores";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ rows: await listarFornecedores() });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.nome) {
    return NextResponse.json({ error: "nome obrigatório" }, { status: 400 });
  }
  try {
    return NextResponse.json(await criarFornecedor(body), { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.fornecedores.criar",
      error: e,
      requestPath: "/api/wms/fornecedores",
      requestMethod: "POST",
      metadata: { nome: body.nome, cnpj: body.cnpj },
    });
  }
}
