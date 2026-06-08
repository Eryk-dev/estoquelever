import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { cancelarCompraManual } from "@/lib/wms/compras-manuais";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const r = await cancelarCompraManual(id);
    if (r.ok) return NextResponse.json({ ok: true });
    const statusMap: Record<string, number> = {
      nao_encontrada: 404,
      tem_recebimento: 409,
      ja_cancelada: 409,
    };
    return NextResponse.json({ error: r.reason }, { status: statusMap[r.reason] ?? 400 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.cancelar",
      error: e,
      requestPath: `/api/wms/compras-manuais/${id}`,
      requestMethod: "DELETE",
    });
  }
}
