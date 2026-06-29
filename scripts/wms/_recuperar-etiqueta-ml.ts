#!/usr/bin/env tsx
/**
 * Recupera etiquetas ZPL direto do Mercado Livre (bypassa o Tiny) pros pedidos
 * EasyPeasy ML que ficaram sem etiqueta. O retry-etiqueta padrão usa o caminho
 * Tiny (preCriarAgrupamentosEmLote), que exige nota_fiscal_id+chave no SISO —
 * esses pedidos perderam o link da NF (jobs mortos do downtime), então o Tiny
 * nunca tenta e o fallback ML nunca dispara. Aqui chamamos o ML direto:
 * obterEtiquetaZplShipment → salva etiqueta_zpl + barcodes + status pendente
 * (mesma lógica de recuperarEtiquetaViaMl, que não é exportada).
 *
 * Diagnóstico provou que /shipment_labels?...zpl2 retorna 200 (zip) p/ esses
 * shipments (ready_to_print). Sem NF, sem Tiny.
 *
 *   npx tsx scripts/wms/_recuperar-etiqueta-ml.ts --limit 5    # teste
 *   npx tsx scripts/wms/_recuperar-etiqueta-ml.ts              # tudo
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  obterEtiquetaZplShipment,
  getMlShipmentStatus,
  getMlShipmentStatusById,
} from "../../src/lib/ml-api";
import { montarBarcodesEtiqueta } from "../../src/lib/etiqueta-barcode";
import { extrairBarcodesDoRaster } from "../../src/lib/etiqueta-barcode-raster";

const EASYPEASY = "818f5445-6704-4045-9179-068ba507d480";
const ESTADOS = ["aguardando_separacao", "em_separacao", "separado", "embalado", "conferido"];

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : 0;

async function main() {
  const sb = createServiceClient();

  let q = sb
    .from("siso_pedidos")
    .select("id, numero, empresa_origem_id, id_pedido_ecommerce, ml_shipment_id, status_separacao, nome_ecommerce")
    .eq("empresa_origem_id", EASYPEASY)
    .ilike("nome_ecommerce", "%mercado livre%")
    .neq("status", "cancelado")
    .is("etiqueta_zpl", null)
    .in("status_separacao", ESTADOS)
    .not("id_pedido_ecommerce", "is", null)
    .order("status_separacao", { ascending: false });

  if (LIMIT > 0) q = q.limit(LIMIT);

  const { data, error } = await q;
  if (error) throw new Error(`query: ${error.message}`);
  const pedidos = data ?? [];

  console.log(`\n${pedidos.length} pedido(s) EasyPeasy ML sem etiqueta${LIMIT ? ` (limit ${LIMIT})` : ""}\n`);

  const connId = await getActiveMlConnectionForEmpresa(EASYPEASY);
  if (!connId) throw new Error("EasyPeasy sem conexão ML ativa");

  const READY_SUB = new Set(["ready_to_print", "printed", "picked_up"]);
  const READY_ST = new Set(["shipped", "delivered"]);

  let ok = 0;
  let buffered = 0;
  let falha = 0;
  const falhas: Array<{ id: string; motivo: string }> = [];

  for (const p of pedidos) {
    try {
      // 1. Checa substatus ANTES de baixar — buffered (futura) o ML recusa
      //    imprimir (NOT_PRINTABLE_STATUS), não adianta tentar.
      const st = p.ml_shipment_id
        ? await getMlShipmentStatusById(connId, p.ml_shipment_id)
        : await getMlShipmentStatus(connId, String(p.id_pedido_ecommerce));

      const pronto =
        !!st && ((st.substatus && READY_SUB.has(st.substatus)) || (st.status && READY_ST.has(st.status)));

      if (!pronto) {
        const tag = st?.substatus ?? st?.status ?? "sem shipment";
        if (st?.substatus === "buffered" || st?.status === "pending") {
          buffered++;
          console.log(`  ${p.id} (nº ${p.numero})  🔒 buffered (etiqueta segurada pelo ML — futura)`);
        } else {
          falha++;
          falhas.push({ id: p.id, motivo: `não pronto: ${tag}` });
          console.log(`  ${p.id} (nº ${p.numero})  ⏳ ${tag}`);
        }
        await sleep(800);
        continue;
      }

      const res = await obterEtiquetaZplShipment(connId, String(p.id_pedido_ecommerce));
      if (!res?.zpl) {
        falha++;
        falhas.push({ id: p.id, motivo: "ready mas download/extração falhou" });
        console.log(`  ${p.id} (nº ${p.numero})  ⚠️ null (ready mas sem zpl)`);
        await sleep(800);
        continue;
      }

      const doRaster = await extrairBarcodesDoRaster(res.zpl);
      const barcodes = montarBarcodesEtiqueta(res.zpl, [res.trackingNumber, ...doRaster]);

      const upd: Record<string, unknown> = { etiqueta_zpl: res.zpl };
      if (barcodes.length > 0) upd.etiqueta_barcodes = barcodes;
      if (!p.ml_shipment_id && res.shipmentId) upd.ml_shipment_id = String(res.shipmentId);

      const { error: e1 } = await sb.from("siso_pedidos").update(upd).eq("id", p.id);
      if (e1) {
        falha++;
        falhas.push({ id: p.id, motivo: `update: ${e1.message}` });
        console.log(`  ${p.id} (nº ${p.numero})  ❌ save: ${e1.message}`);
        await sleep(800);
        continue;
      }

      // status da etiqueta via RPC (coluna tem quirk de schema-cache no PostgREST)
      await sb.rpc("siso_set_etiqueta_status", { p_pedido_id: p.id, p_status: "pendente" })
        .then(() => {}, () => {});

      ok++;
      console.log(`  ${p.id} (nº ${p.numero})  ✅ ZPL salvo (${res.zpl.length}b, ${barcodes.length} barcodes)`);
    } catch (err) {
      falha++;
      const msg = err instanceof Error ? err.message : String(err);
      falhas.push({ id: p.id, motivo: msg });
      console.log(`  ${p.id} (nº ${p.numero})  ❌ ${msg}`);
    }
    await sleep(800); // throttle ML rate-limit
  }

  console.log(`\n── resumo ──\n✅ recuperadas: ${ok}\n🔒 buffered (futura, ML segura): ${buffered}\n❌ falhas: ${falha}`);
  if (falhas.length) {
    console.log(`\nfalhas:`);
    for (const f of falhas) console.log(`  ${f.id}  ${f.motivo}`);
  }
  console.log("");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => { console.error(e); process.exit(1); });
