import { NextRequest, NextResponse } from "next/server";
import { aplicarSessao } from "@/lib/wms/inventario";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// Aplicar uma sessão escreve movs no ledger e mexe no saldo real —
// gate restrito a admin/supervisor.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const r = await aplicarSessao(id, auth.user.id);
    return NextResponse.json(r);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isSaldo = /saldo|insuficiente|reservado|inviável/i.test(msg);
    return wmsErrorResponse({
      source: "wms.inventario.aplicar",
      error: e,
      status: isSaldo ? 409 : 400,
      requestPath: `/api/wms/inventario/${id}/aplicar`,
      requestMethod: "POST",
      metadata: { sessao_id: id },
    });
  }
}
