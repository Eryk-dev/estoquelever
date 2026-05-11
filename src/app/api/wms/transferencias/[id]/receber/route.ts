import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { receberTransferencia } from "@/lib/wms/transferencias";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await req.json();
  if (!Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json(
      { error: "itens[] obrigatório (cada com transferencia_item_id e localizacao_destino_id)" },
      { status: 400 },
    );
  }
  try {
    await receberTransferencia({
      transferencia_id: id,
      itens: body.itens,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.transferencias.receber",
      error: e,
      status: 400,
      requestPath: `/api/wms/transferencias/${id}/receber`,
      requestMethod: "POST",
      metadata: { transferencia_id: id, n_itens: body.itens?.length },
    });
  }
}
