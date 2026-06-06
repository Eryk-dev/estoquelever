import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccessOrOwnVenda } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { cancelarVendaManual } from "@/lib/wms/vendas-cancelamento";

/**
 * POST /api/wms/vendas/[id]/cancelar
 *
 * Body: { motivo: string }
 *
 * P3 #7.13 — Cancela venda manual.
 *
 * Caminhos cobertos:
 *   - status_separacao='aguardando_separacao'|'aguardando_compra': libera
 *     reservas R via liberarReserva (idempotente — se já houver L, skip).
 *   - status='concluido' com movs origem_tipo='venda_manual': estorna cada
 *     mov S (idempotência por estorno_de — re-cancelamento retorna 0/0).
 *   - status_separacao ∈ {em_separacao, separado, embalado}: libera R abertas,
 *     preserva movs S dos pegos (auditoria), marca cancelado, retorna
 *     itens_para_devolver_manual (pegos → devolução manual).
 *   - status='cancelado': retorna 200 com 0/0 (idempotente).
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireWarehouseAccessOrOwnVenda(req, id);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo (≥3 chars) é obrigatório" },
      { status: 400 },
    );
  }

  try {
    const r = await cancelarVendaManual({
      pedido_id: id,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({
      ok: true,
      movs_estornadas: r.movsEstornadas,
      reservas_liberadas: r.reservasLiberadas,
      itens_para_devolver_manual: r.itensParaDevolverManual,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrado") ||
      msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.vendas.cancelar",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/vendas/${id}/cancelar`,
      requestMethod: "POST",
      metadata: { pedido_id: id },
    });
  }
}
