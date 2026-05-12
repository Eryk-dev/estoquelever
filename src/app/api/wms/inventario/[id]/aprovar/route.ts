import { NextRequest, NextResponse } from "next/server";
import { aprovarSessao, computarDivergencias } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  let parcial = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { parcial?: unknown };
    parcial = body?.parcial === true;
  } catch {
    // body opcional — ignora erro de parsing
  }
  try {
    await computarDivergencias(id, { parcial });
    await aprovarSessao(id, auth.user.id);
    return NextResponse.json({ ok: true, parcial });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.aprovar",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/aprovar`,
      requestMethod: "POST",
      metadata: { sessao_id: id, parcial },
    });
  }
}
