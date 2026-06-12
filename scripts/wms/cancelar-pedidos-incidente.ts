#!/usr/bin/env tsx
/**
 * scripts/wms/cancelar-pedidos-incidente.ts — one-off (2026-06-12).
 * Cancela no SISO os 3 pedidos recuperados do incidente do webhook que o
 * Eryk confirmou já terem sido atendidos pelo outro sistema (51061, 51062,
 * 51111). Usa handlePedidoCancelamento (libera reservas R, cancela jobs da
 * fila, marca pedido cancelado).
 *
 * Rodar: npx tsx scripts/wms/cancelar-pedidos-incidente.ts
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { handlePedidoCancelamento } from "../../src/lib/pedido-cancel-handler";

const EASYPEASY = "818f5445-6704-4045-9179-068ba507d480";
const PEDIDOS = ["938211317", "938211421", "938219965"]; // 51061, 51062, 51111

async function main() {
  const sb = createServiceClient();
  for (const pedidoId of PEDIDOS) {
    const { data: log } = await sb
      .from("siso_webhook_logs")
      .select("id")
      .eq("tiny_pedido_id", pedidoId)
      .order("criado_em", { ascending: false })
      .limit(1)
      .single();
    if (!log) {
      console.log(`${pedidoId}: sem webhook log — pulando`);
      continue;
    }
    const result = await handlePedidoCancelamento({
      pedidoId,
      webhookLogId: log.id,
      empresaId: EASYPEASY,
    });
    console.log(`${pedidoId}: ${JSON.stringify(result)}`);
  }
}

main().then(() => process.exit(0));
