import { NextRequest, NextResponse } from "next/server";
import { registrarContagem } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  try {
    await registrarContagem({
      ...body,
      sessao_id: id,
      contada_por: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.contagens",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/contagens`,
      requestMethod: "POST",
      metadata: {
        sessao_id: id,
        localizacao_id: body.localizacao_id,
        produto_id: body.produto_id,
      },
    });
  }
}
