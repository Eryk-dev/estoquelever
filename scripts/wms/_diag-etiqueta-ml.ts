#!/usr/bin/env tsx
/**
 * Diagnóstico: por que a etiqueta ML não baixa. Mostra o erro RAW do
 * /shipment_labels (obterEtiquetaZplShipment engole e retorna null).
 * Confirma o estado atual do shipment e tenta zpl2 + pdf.
 *
 *   npx tsx scripts/wms/_diag-etiqueta-ml.ts 938500735 [outroId...]
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { getActiveMlConnectionForEmpresa, getMlShipmentSla } from "../../src/lib/ml-api";
import { ML_API_BASE, getValidMlToken } from "../../src/lib/ml-oauth";

const orderIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const alvos = orderIds.length ? orderIds : ["938500735"];

async function main() {
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_pedidos")
    .select("id, numero, empresa_origem_id, id_pedido_ecommerce, ml_shipment_id, status_separacao, nome_ecommerce")
    .in("id", alvos);

  for (const p of data ?? []) {
    console.log(`\n=== ${p.id} (nº ${p.numero}) ${p.status_separacao} — ${p.nome_ecommerce} ===`);
    if (!p.empresa_origem_id) { console.log("  sem empresa"); continue; }
    const connId = await getActiveMlConnectionForEmpresa(p.empresa_origem_id);
    if (!connId) { console.log("  sem conexão ML ativa"); continue; }
    const token = await getValidMlToken(connId);

    let sid: string | number | null = p.ml_shipment_id;
    if (!sid && p.id_pedido_ecommerce) {
      const sla = await getMlShipmentSla(connId, String(p.id_pedido_ecommerce));
      sid = sla?.shipmentId ?? null;
      console.log(`  shipmentId resolvido via order/pack: ${sid}`);
    }
    if (!sid) { console.log("  sem shipmentId"); continue; }

    // estado atual do shipment
    const shRes = await fetch(`${ML_API_BASE}/shipments/${sid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const shTxt = await shRes.text();
    let sh: Record<string, unknown> = {};
    try { sh = JSON.parse(shTxt); } catch { /* */ }
    console.log(
      `  shipment ${sid}: HTTP ${shRes.status} status=${sh.status} substatus=${sh.substatus} logistic_type=${sh.logistic_type} mode=${sh.mode}`,
    );

    // tenta baixar a etiqueta nos 2 formatos, mostrando o erro cru
    for (const rt of ["zpl2", "pdf"]) {
      const url = `${ML_API_BASE}/shipment_labels?shipment_ids=${sid}&response_type=${rt}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const ct = r.headers.get("content-type") ?? "";
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        console.log(`  /shipment_labels ${rt}: HTTP ${r.status} OK ct=${ct} bytes=${buf.length}`);
      } else {
        const body = await r.text();
        console.log(`  /shipment_labels ${rt}: HTTP ${r.status} ct=${ct} body=${body.slice(0, 500)}`);
      }
    }
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
