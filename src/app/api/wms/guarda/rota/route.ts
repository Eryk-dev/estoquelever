import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { listarRotaPendencias } from "@/lib/wms/guarda";

/**
 * GET /api/wms/guarda/rota
 *
 * Retorna pendências numa rota ordenada (loc destino asc, NULL no fim).
 * Filtros mutuamente compatíveis — ao menos um precisa ser passado:
 *   - ?lote=UUID — todas as pendências do mesmo recebimento
 *   - ?ids=a,b,c — seleção ad-hoc
 *   - ?galpao=UUID&todas=true — todas ativas do galpão (botão "Guardar tudo")
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const lote = sp.get("lote") ?? undefined;
  const idsParam = sp.get("ids");
  const ids = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const galpao = sp.get("galpao") ?? undefined;
  const todas = sp.get("todas") === "true";

  try {
    const rows = await listarRotaPendencias({
      lote_id: lote,
      pendencia_ids: ids,
      galpao_id: galpao,
      todas,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient = msg.includes("informe lote_id");
    return wmsErrorResponse({
      source: "wms.guarda.rota",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: "/api/wms/guarda/rota",
      requestMethod: "GET",
      metadata: { lote, ids, galpao, todas },
    });
  }
}
