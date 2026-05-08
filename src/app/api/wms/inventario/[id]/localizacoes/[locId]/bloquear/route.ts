import { NextRequest, NextResponse } from "next/server";
import { pegarLocalizacao, liberarLocalizacao } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; locId: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id, locId } = await params;
  try {
    await pegarLocalizacao(id, locId, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.bloquear",
      error: e,
      status: 409,
      requestPath: `/api/wms/inventario/${id}/localizacoes/${locId}/bloquear`,
      requestMethod: "POST",
      metadata: { sessao_id: id, localizacao_id: locId },
    });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; locId: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id, locId } = await params;
  try {
    await liberarLocalizacao(id, locId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.bloquear",
      error: e,
      requestPath: `/api/wms/inventario/${id}/localizacoes/${locId}/bloquear`,
      requestMethod: "DELETE",
      metadata: { sessao_id: id, localizacao_id: locId },
    });
  }
}
