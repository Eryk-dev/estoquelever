import { NextRequest, NextResponse } from "next/server";
import { sairSlot } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// DELETE /api/wms/inventario/[id]/slots
// Operador (auth.user) sai do slot que está atualmente. Locks de loc em
// em_contagem ficam até cleanup cron (siso_inventario_recovery) liberar.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await sairSlot(id, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.slot.sair",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/slots`,
      requestMethod: "DELETE",
      metadata: { sessao_id: id, usuario_id: auth.user.id },
    });
  }
}
