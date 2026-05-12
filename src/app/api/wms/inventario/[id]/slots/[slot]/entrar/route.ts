import { NextRequest, NextResponse } from "next/server";
import { entrarSlot } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// POST /api/wms/inventario/[id]/slots/[slot]/entrar
// Operador (auth.user) assume o slot indicado nesta sessão.
// Auto-inicia a sessão se ainda estiver em 'planejada'.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; slot: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id, slot: slotStr } = await params;
  const slot = parseInt(slotStr, 10);
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) {
    return NextResponse.json(
      { error: "slot deve ser inteiro entre 1 e 5" },
      { status: 400 },
    );
  }

  try {
    await entrarSlot(id, slot, auth.user.id);
    return NextResponse.json({ ok: true, slot });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.slot.entrar",
      error: e,
      status: 409,
      requestPath: `/api/wms/inventario/${id}/slots/${slot}/entrar`,
      requestMethod: "POST",
      metadata: { sessao_id: id, slot, usuario_id: auth.user.id },
    });
  }
}
