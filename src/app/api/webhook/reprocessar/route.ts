import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { processWebhook } from "@/lib/webhook-processor";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhook/reprocessar
 *
 * Reprocesses failed webhook logs (status = 'pendente' after reset).
 * Used to retry orders that failed due to bugs that have since been fixed.
 */
export async function POST() {
  const supabase = createServiceClient();

  const { data: logs, error } = await supabase
    .from("siso_webhook_logs")
    .select("id, tiny_pedido_id, filial")
    .eq("codigo_situacao", "aprovado")
    .eq("status", "pendente")
    .order("criado_em", { ascending: true });

  if (error || !logs?.length) {
    return NextResponse.json({ message: "Nenhum webhook pendente para reprocessar", count: 0 });
  }

  logger.info("reprocessar", `Reprocessando ${logs.length} webhooks`, {
    pedidoIds: logs.map((l) => l.tiny_pedido_id),
  });

  const results: { pedidoId: string; status: string; erro?: string }[] = [];

  for (const log of logs) {
    try {
      await processWebhook(log.id, log.tiny_pedido_id, log.filial as "CWB" | "SP");
      results.push({ pedidoId: log.tiny_pedido_id, status: "ok" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ pedidoId: log.tiny_pedido_id, status: "erro", erro: msg });
    }
  }

  return NextResponse.json({ reprocessed: results.length, results });
}
