import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { confirmarGuarda } from "@/lib/wms/guarda";

/**
 * POST /api/wms/guarda/[id]/confirmar
 *
 * Body: { qty: number, localizacao_destino_id: string }
 *
 * Faz a movimentação par S+E (replenishment_intra) RECEBIMENTO→loc destino.
 * Suporta guarda parcial: qty < qty_pendente deixa a pendência aberta.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body inválido" }, { status: 400 });
  }
  const qty = Number(body.qty);
  const localizacaoDestinoId = body.localizacao_destino_id;
  if (!qty || qty <= 0 || !localizacaoDestinoId) {
    return NextResponse.json(
      { error: "qty (>0) e localizacao_destino_id são obrigatórios" },
      { status: 400 },
    );
  }

  try {
    const r = await confirmarGuarda({
      pendencia_id: id,
      qty,
      localizacao_destino_id: localizacaoDestinoId,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("status terminal") ||
      msg.includes("excede pendente") ||
      msg.includes("loc destino") ||
      msg.includes("localização destino") ||
      msg.includes("outro galpão") ||
      msg.includes("inativa") ||
      msg.includes("qty deve ser");
    return wmsErrorResponse({
      source: "wms.guarda.confirmar",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/guarda/${id}/confirmar`,
      requestMethod: "POST",
      metadata: { pendencia_id: id, qty, localizacaoDestinoId },
    });
  }
}
