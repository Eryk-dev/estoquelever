import { NextRequest, NextResponse } from "next/server";
import { saldosPorPerspectiva } from "@/lib/wms/estoque";
import { getSessionUser } from "@/lib/session";
import type { PerspectivaEstoque } from "@/lib/wms/types";

const VIEWS = new Set<PerspectivaEstoque>(["dono", "galpao", "localizacao", "produto"]);

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const view = (sp.get("view") ?? "produto") as PerspectivaEstoque;
  if (!VIEWS.has(view)) return NextResponse.json({ error: "view inválida" }, { status: 400 });

  try {
    const rows = await saldosPorPerspectiva(view, {
      produto_id: sp.get("produto_id") ?? undefined,
      empresa_id: sp.get("empresa_id") ?? undefined,
      galpao_id: sp.get("galpao_id") ?? undefined,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
