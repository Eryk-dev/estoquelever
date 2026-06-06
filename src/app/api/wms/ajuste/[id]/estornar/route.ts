import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { estornarAjuste } from "@/lib/wms/movimentacoes";

/**
 * POST /api/wms/ajuste/[id]/estornar
 *
 * `[id]` é o `mov_id` retornado por `POST /api/wms/ajuste`.
 *
 * Body: { motivo: string }  (≥3 chars)
 *
 * Estorna a mov de ajuste manual: valida `origem_tipo='ajuste_manual'`
 * (recusa estornar movs de outras origens por aqui) e delega pra
 * `estornarMovimentacao`. Idempotente — double-estorno é rejeitado pelo
 * guard `estorno_de IS NOT NULL`.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "operacoes.ajuste_manual")) {
    return NextResponse.json(
      { error: "requer permissão operacoes.ajuste_manual" },
      { status: 403 },
    );
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo (≥3 chars) é obrigatório" },
      { status: 400 },
    );
  }
  try {
    await estornarAjuste({
      mov_id: id,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("mov não encontrada") ||
      msg.includes("não é ajuste_manual") ||
      msg.includes("já foi estornada") ||
      msg.includes("já é um estorno") ||
      msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.ajuste.estornar",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/ajuste/${id}/estornar`,
      requestMethod: "POST",
      metadata: { mov_id: id },
    });
  }
}
