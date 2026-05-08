import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { ajustarEstoque } from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  try {
    await ajustarEstoque({ ...body, usuario_id: auth.user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.ajuste",
      error: e,
      status: 400,
      requestPath: "/api/wms/ajuste",
      requestMethod: "POST",
    });
  }
}
