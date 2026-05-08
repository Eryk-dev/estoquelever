import { NextRequest, NextResponse } from "next/server";
import { listarRegras, criarRegra } from "@/lib/wms/emprestimos";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ rows: await listarRegras() });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  try {
    return NextResponse.json(await criarRegra(body), { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.emprestimo-regras.criar",
      error: e,
      status: 400,
      requestPath: "/api/wms/emprestimo-regras",
      requestMethod: "POST",
    });
  }
}
