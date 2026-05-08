import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { rotearPedidoDoBanco } from "@/lib/wms/roteamento";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.empresa_vendedora_id || !Array.isArray(body.itens)) {
    return NextResponse.json(
      { error: "empresa_vendedora_id e itens obrigatórios" },
      { status: 400 },
    );
  }
  try {
    const r = await rotearPedidoDoBanco(body.empresa_vendedora_id, body.itens);
    return NextResponse.json(r);
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.rotear",
      error: e,
      requestPath: "/api/wms/rotear",
      requestMethod: "POST",
      metadata: {
        empresa_vendedora_id: body.empresa_vendedora_id,
        n_itens: body.itens?.length ?? 0,
      },
    });
  }
}
