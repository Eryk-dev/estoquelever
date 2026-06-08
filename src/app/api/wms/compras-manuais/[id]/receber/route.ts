import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { receberCompraManual } from "@/lib/wms/compras-manuais";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json();
  if (!Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json(
      { error: "envie { itens: [{ item_id, qty_recebida }] }" },
      { status: 400 },
    );
  }
  try {
    const r = await receberCompraManual({
      compra_id: id,
      usuario_id: session.id,
      itens: body.itens.map((it: { item_id: string; qty_recebida: number; custo_unitario?: number }) => ({
        item_id: it.item_id,
        qty_recebida: Number(it.qty_recebida),
        custo_unitario: it.custo_unitario != null ? Number(it.custo_unitario) : null,
      })),
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.receber",
      error: e,
      status: 400,
      requestPath: `/api/wms/compras-manuais/${id}/receber`,
      requestMethod: "POST",
    });
  }
}
