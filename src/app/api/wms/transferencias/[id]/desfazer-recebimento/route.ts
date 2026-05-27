import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { desfazerRecebimentoTransferencia } from "@/lib/wms/transferencias";

/**
 * POST /api/wms/transferencias/[id]/desfazer-recebimento
 *
 * Body: { motivo: string }
 *
 * Estorna apenas a leg E (entrada destino) das movs do recebimento, reseta
 * itens (`mov_entrada_id=NULL`, `localizacao_destino_id=NULL`), volta o header
 * pra `status='em_transito'`. Permite re-receber depois.
 *
 * A leg S (saída origem) permanece — estoque continua "em trânsito".
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

  try {
    const r = await desfazerRecebimentoTransferencia({
      transferencia_id: id,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("podem ter recebimento desfeito") ||
      msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.transferencias.desfazer-recebimento",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/transferencias/${id}/desfazer-recebimento`,
      requestMethod: "POST",
      metadata: { transferencia_id: id },
    });
  }
}
