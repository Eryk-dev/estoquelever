import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { desfazerGuarda } from "@/lib/wms/guarda";

/**
 * POST /api/wms/guarda/[id]/desfazer
 *
 * Body: { motivo: string, qty?: number }
 *
 * Estorna par S+E da última (ou única) confirmação dessa pendência,
 * decrementa qty_guardada, recupera status='pendente'|'em_guarda'.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo (≥3 chars) é obrigatório" },
      { status: 400 },
    );
  }
  const qty = body?.qty !== undefined ? Number(body.qty) : undefined;

  try {
    const r = await desfazerGuarda({
      pendencia_id: id,
      qty,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("cancelada") ||
      msg.includes("sem guardas") ||
      msg.includes("MVP") ||
      msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.guarda.desfazer",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/guarda/${id}/desfazer`,
      requestMethod: "POST",
      metadata: { pendencia_id: id, qty },
    });
  }
}
