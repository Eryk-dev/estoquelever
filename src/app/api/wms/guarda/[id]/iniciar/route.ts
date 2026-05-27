import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { iniciarGuarda } from "@/lib/wms/guarda";

/**
 * POST /api/wms/guarda/[id]/iniciar
 *
 * Marca status='em_guarda' (idempotente). Operador clicou no card da fila.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  try {
    const pend = await iniciarGuarda({
      pendencia_id: id,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true, pendencia: pend });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    const iniciadaPor = (e as { iniciada_por?: string }).iniciada_por;
    // Race perdida — outro operador reivindicou primeiro. UI usa
    // `iniciada_por` pra mostrar avatar/nome do dono atual.
    if (code === "PENDENCIA_OUTRA_GUARDA") {
      return NextResponse.json(
        { error: msg, code, iniciada_por: iniciadaPor },
        { status: 409 },
      );
    }
    const isClient =
      msg.includes("não encontrada") || msg.includes("status terminal");
    return wmsErrorResponse({
      source: "wms.guarda.iniciar",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/guarda/${id}/iniciar`,
      requestMethod: "POST",
      metadata: { pendencia_id: id },
    });
  }
}
