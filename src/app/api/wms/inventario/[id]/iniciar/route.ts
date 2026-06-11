import { NextRequest, NextResponse } from "next/server";
import { iniciarSessao } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await iniciarSessao(id, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // [P2-INV-02] locs já travadas por outra sessão — 409 com os códigos pra UI.
    if ((e as { code?: string }).code === "locs_bloqueadas") {
      return NextResponse.json(
        {
          error: "locs_bloqueadas",
          message: e instanceof Error ? e.message : String(e),
          locs: (e as { locs?: string[] }).locs ?? [],
        },
        { status: 409 },
      );
    }
    return wmsErrorResponse({
      source: "wms.inventario.iniciar",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/iniciar`,
      requestMethod: "POST",
      metadata: { sessao_id: id },
    });
  }
}
