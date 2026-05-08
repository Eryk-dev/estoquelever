import { NextRequest, NextResponse } from "next/server";
import { saldosPorPerspectiva } from "@/lib/wms/estoque";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import type { PerspectivaEstoque } from "@/lib/wms/types";

const VIEWS = new Set<PerspectivaEstoque>(["dono", "galpao", "localizacao", "produto"]);

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const view = (sp.get("view") ?? "produto") as PerspectivaEstoque;
  if (!VIEWS.has(view))
    return NextResponse.json({ error: "view inválida" }, { status: 400 });

  try {
    const rows = await saldosPorPerspectiva(view, {
      produto_id: sp.get("produto_id") ?? undefined,
      empresa_id: sp.get("empresa_id") ?? undefined,
      galpao_id: sp.get("galpao_id") ?? undefined,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.estoque",
      error: e,
      requestPath: "/api/wms/estoque",
      requestMethod: "GET",
      metadata: { view },
    });
  }
}
