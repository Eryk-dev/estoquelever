import { NextRequest, NextResponse } from "next/server";
import { trocarSku } from "@/lib/wms/troca-sku";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (
    !body.pedido_id ||
    !body.quadrupla_original ||
    !body.quadrupla_substituto ||
    !body.qty
  ) {
    return NextResponse.json(
      { error: "campos obrigatórios faltando" },
      { status: 400 },
    );
  }
  try {
    await trocarSku({ ...body, usuario_id: auth.user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.troca-sku",
      error: e,
      status: 400,
      requestPath: "/api/wms/troca-sku",
      requestMethod: "POST",
      metadata: { pedido_id: body.pedido_id },
    });
  }
}
