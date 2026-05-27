import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { cancelarTransferencia } from "@/lib/wms/transferencias";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const result = await cancelarTransferencia(id, auth.user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.transferencias.cancelar",
      error: e,
      status: 400,
      requestPath: `/api/wms/transferencias/${id}/cancelar`,
      requestMethod: "POST",
      metadata: { transferencia_id: id },
    });
  }
}
