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
    // P3 #8.10: race perdida — outro operador já reivindicou o recebimento.
    // UI usa `recebimento_em_andamento_por` pra mostrar quem ganhou.
    const code = (e as { code?: string }).code;
    if (code === "TRANSFERENCIA_OUTRO_RECEBIMENTO") {
      const msg = e instanceof Error ? e.message : String(e);
      const dono = (e as { recebimento_em_andamento_por?: string })
        .recebimento_em_andamento_por;
      return NextResponse.json(
        { error: msg, code, recebimento_em_andamento_por: dono },
        { status: 409 },
      );
    }
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
