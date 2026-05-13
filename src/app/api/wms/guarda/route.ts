import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { listarPendencias, type StatusPendencia } from "@/lib/wms/guarda";

const STATUS_VALIDOS: StatusPendencia[] = [
  "pendente",
  "em_guarda",
  "guardada",
  "cancelada",
];

/**
 * GET /api/wms/guarda
 *
 * Lista pendências de guarda. Default mostra só ativas (pendente + em_guarda).
 *
 * Query:
 *   ?galpao_id=uuid          (opcional)
 *   ?empresa_dona_id=uuid    (opcional)
 *   ?status=pendente,em_guarda  (CSV; default: pendente,em_guarda)
 *   ?q=termo                 (busca em sku/descrição)
 *   ?limit=N                 (default 200)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const sp = req.nextUrl.searchParams;

  const statusParam = sp.get("status");
  let status: StatusPendencia[] | undefined;
  if (statusParam) {
    const parsed = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is StatusPendencia =>
        (STATUS_VALIDOS as string[]).includes(s),
      );
    if (parsed.length === 0) {
      return NextResponse.json(
        { error: "status inválido" },
        { status: 400 },
      );
    }
    status = parsed;
  }

  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Math.min(500, Math.max(1, parseInt(limitRaw, 10))) : undefined;

  try {
    const rows = await listarPendencias({
      galpao_id: sp.get("galpao_id") ?? undefined,
      empresa_dona_id: sp.get("empresa_dona_id") ?? undefined,
      status,
      q: sp.get("q") ?? undefined,
      limit,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.guarda.listar",
      error: e,
      requestPath: "/api/wms/guarda",
      requestMethod: "GET",
    });
  }
}
