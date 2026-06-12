#!/usr/bin/env tsx
/**
 * scripts/wms/agrupamentos-incidente.ts — one-off (2026-06-12).
 * Cria agrupamentos fase-1 pros 16 pedidos recuperados do incidente do
 * webhook que o Eryk confirmou que seguem no SISO (NFs 019959–019974).
 * criarAgrupamentoFase1 tem gates internos (NF completa, claim atômico,
 * "já foi expedida"), então é seguro re-rodar.
 *
 * Rodar: npx tsx scripts/wms/agrupamentos-incidente.ts
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { criarAgrupamentoFase1 } from "../../src/lib/agrupamento-service";

const PEDIDOS = [
  "937845304", // 48954
  "937864604", // 49049
  "938039226", // 50089
  "938084558", // 50346
  "938086309", // 50358
  "938127831", // 50592
  "938161494", // 50846
  "938166909", // 50894
  "938204034", // 51034
  "938224325", // 51127
  "938228440", // 51149
  "938230733", // 51163
  "938235288", // 51190
  "938235502", // 51194
  "938235910", // 51197
  "938239502", // 51225
];

async function main() {
  const sb = createServiceClient();
  for (const pedidoId of PEDIDOS) {
    await criarAgrupamentoFase1(pedidoId);
    const { data } = await sb
      .from("siso_pedidos")
      .select("numero, agrupamento_expedicao_id, etiqueta_zpl")
      .eq("id", pedidoId)
      .single();
    console.log(
      `${pedidoId} (${data?.numero}): agrupamento=${data?.agrupamento_expedicao_id ?? "NULL"} zpl=${data?.etiqueta_zpl ? "sim" : "nao"}`,
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().then(() => process.exit(0));
