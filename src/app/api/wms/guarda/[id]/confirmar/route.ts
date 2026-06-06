import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { confirmarGuarda } from "@/lib/wms/guarda";
import { dispararTriggerCrossDock } from "@/lib/wms/crossdock-trigger";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/guarda/[id]/confirmar
 *
 * Body: { qty, localizacao_destino_id, gtin_bipado?, sku_bipado?, confirmar_manual? }
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

  const gtinBipado = typeof body.gtin_bipado === "string" ? body.gtin_bipado : null;
  const skuBipado = typeof body.sku_bipado === "string" ? body.sku_bipado : null;
  const confirmarManual = body.confirmar_manual === true;

  try {
    const r = await confirmarGuarda({
      pendencia_id: id,
      qty,
      localizacao_destino_id: localizacaoDestinoId,
      usuario_id: auth.user.id,
      gtin_bipado: gtinBipado,
      sku_bipado: skuBipado,
      confirmar_manual: confirmarManual,
    });

    // Decisão (28/05): se pendência era cross-dock + destino é PACKING,
    // varre pedidos vinculados e dispara prepararPedidosDasOcs pra eles.
    let pedidosSeparados: string[] = [];
    try {
      const trigger = await dispararTriggerCrossDock({
        pendencia_id: id,
        destino_final_id: localizacaoDestinoId,
      });
      pedidosSeparados = trigger.pedidos_separados;
    } catch (triggerErr) {
      logger.warn(
        "guarda.confirmar",
        "trigger cross-dock falhou (não-fatal)",
        {
          pendencia_id: id,
          err:
            triggerErr instanceof Error
              ? triggerErr.message
              : String(triggerErr),
        },
      );
    }

    // O estoque acabou de chegar numa loc via put-away. O par S+E do
    // replenishment é puro-RPC (não passa pelo gancho de mov E do ledger),
    // então disparamos o reconciliador aqui pra devolver ao picking os
    // pedidos OC parados cujo saldo agora cobre. Awaited + não-fatal.
    try {
      const { reconciliarEntradaEstoque } = await import(
        "@/lib/wms/reconciliador-oc"
      );
      await reconciliarEntradaEstoque({
        produtoId: r.pendencia.produto_id,
        galpaoId: r.pendencia.galpao_id,
      });
    } catch (recErr) {
      logger.warn(
        "guarda.confirmar",
        "reconciliador pós-guarda falhou (não-fatal)",
        {
          pendencia_id: id,
          err: recErr instanceof Error ? recErr.message : String(recErr),
        },
      );
    }

    return NextResponse.json({
      ok: true,
      ...r,
      pedidos_separados: pedidosSeparados,
    });
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
      msg.includes("qty deve ser") ||
      msg.includes("produto bipado não bate");
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
