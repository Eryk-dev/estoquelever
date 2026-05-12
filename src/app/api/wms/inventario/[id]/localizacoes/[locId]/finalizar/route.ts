import { NextRequest, NextResponse } from "next/server";
import { finalizarLoc } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// POST /api/wms/inventario/[id]/localizacoes/[locId]/finalizar
// O parâmetro [locId] é o id da row em siso_inventario_localizacoes (inv_loc_id).
// Marca a loc como contada, libera o lock, incrementa contador do operador.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; locId: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id, locId } = await params;
  try {
    await finalizarLoc(id, locId, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.finalizar_loc",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/localizacoes/${locId}/finalizar`,
      requestMethod: "POST",
      metadata: { sessao_id: id, inv_loc_id: locId, usuario_id: auth.user.id },
    });
  }
}
