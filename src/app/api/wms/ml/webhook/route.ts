import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { processMlNotification, type MlNotification } from "@/lib/ml-notifications";
import { logger } from "@/lib/logger";

/**
 * Webhook de notificações do Mercado Livre.
 *
 * Público por design (o ML não assina os requests). Não confia no corpo: só age
 * em shipments que casam com uma futura VIVA nossa (siso_pedidos.ml_shipment_id),
 * e mesmo assim re-lê o estado no ML com NOSSO token — uma notificação forjada,
 * no pior caso, custa um GET inútil.
 *
 * Responde 200 IMEDIATO e processa em `after()` — o ML tem timeout curto e
 * re-tenta em não-200 (geraria reprocessamento). Espelha o webhook do Tiny.
 *
 * Config (manual no DevCenter do app ESTOQUE LEVER):
 *   notifications_callback_url = https://estoquelever.vercel.app/api/wms/ml/webhook
 *   tópicos = orders_v2 (intake da futura buffered) + shipments (promoção)
 *
 * maxDuration alto: o intake roda o processWebhook inteiro (fetch do pedido no
 * Tiny via fila rate-limited), igual ao webhook do Tiny.
 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let payload: MlNotification;
  try {
    payload = await request.json();
  } catch {
    // 200 mesmo em corpo inválido — não queremos que o ML fique re-tentando lixo.
    return NextResponse.json({ ok: true });
  }

  logger.info("ml-webhook", "notificação recebida", {
    topic: String(payload.topic ?? ""),
    resource: String(payload.resource ?? ""),
    userId: String(payload.user_id ?? ""),
  });

  after(async () => {
    try {
      const r = await processMlNotification(payload);
      if (r.reason === "promovido" || r.reason === "carregado") {
        logger.info("ml-webhook", "futura processada via webhook", {
          acao: r.reason,
          pedidoId: r.pedidoId ?? "",
        });
      }
    } catch (err) {
      logger.error("ml-webhook", "falha ao processar notificação ML", {
        resource: String(payload.resource ?? ""),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return NextResponse.json({ ok: true });
}

/** ML valida a URL com um GET ao salvar no DevCenter — responde 200. */
export async function GET() {
  return NextResponse.json({ ok: true });
}
