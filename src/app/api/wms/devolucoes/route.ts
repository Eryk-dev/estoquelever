import { NextRequest, NextResponse } from "next/server";
import {
  listarDevolucoesPendentes,
  listarDevolucoesClassificadas,
} from "@/lib/wms/devolucoes";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/wms/devolucoes
 *
 * Query:
 *   - status=classificada → lista devoluções já classificadas (pra UI de
 *     desclassificar). Default = aguardando_classificacao.
 */
export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status === "classificada") {
    return NextResponse.json({ rows: await listarDevolucoesClassificadas() });
  }
  return NextResponse.json({ rows: await listarDevolucoesPendentes() });
}
