import { NextRequest, NextResponse } from "next/server";
import { classificarDevolucao } from "@/lib/wms/devolucoes";
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
    await classificarDevolucao({
      ...body,
      devolucao_id: id,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.devolucoes.classificar",
      error: e,
      status: 400,
      requestPath: `/api/wms/devolucoes/${id}/classificar`,
      requestMethod: "POST",
      metadata: { devolucao_id: id, classificacao: body.classificacao },
    });
  }
}
