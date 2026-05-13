import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { cancelarPendencia } from "@/lib/wms/guarda";

/**
 * POST /api/wms/guarda/[id]/cancelar
 *
 * Body: { motivo: string }
 *
 * Cancela pendência (status='cancelada'). NÃO mexe no estoque — a peça
 * fica na loc RECEBIMENTO. Saída física deve ser feita por ajuste manual
 * ou devolução ao fornecedor em fluxo separado.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.motivo !== "string") {
    return NextResponse.json(
      { error: "motivo é obrigatório" },
      { status: 400 },
    );
  }

  try {
    const pend = await cancelarPendencia({
      pendencia_id: id,
      motivo: body.motivo,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true, pendencia: pend });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("status terminal") ||
      msg.includes("motivo do cancelamento");
    return wmsErrorResponse({
      source: "wms.guarda.cancelar",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/guarda/${id}/cancelar`,
      requestMethod: "POST",
      metadata: { pendencia_id: id },
    });
  }
}
