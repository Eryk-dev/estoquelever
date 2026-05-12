import { NextRequest, NextResponse } from "next/server";
import { aprovarSessao } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// Avança a sessão de "revisao" → "aprovada" depois que o supervisor
// resolveu todas as divergências pendentes na página /divergencias.
// Validação de pendentes acontece em aprovarSessao().
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await aprovarSessao(id, auth.user.id);
    return NextResponse.json({ ok: true, status: "aprovada" });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.aprovar-sessao",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/aprovar-sessao`,
      requestMethod: "POST",
      metadata: { sessao_id: id },
    });
  }
}
