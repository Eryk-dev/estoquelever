/**
 * Backfill: atualiza `siso_pedidos.prazo_envio` com o prazo de despacho (SLA)
 * do Mercado Livre para pedidos ML já existentes. O webhook só enriquece
 * pedidos novos; este script cobre o histórico.
 *
 * Sobrescreve prazo_envio (Tiny → dia-only) pela hora exata do ML quando
 * disponível. Mantém o valor atual se o ML não expõe SLA.
 *
 * Roda: npx tsx scripts/wms/backfill-prazo-envio-ml.ts [--dry] [limite]
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  getMlShipmentSla,
} from "../../src/lib/ml-api";

const DRY = process.argv.includes("--dry");
const LIMITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? "2000");

async function main() {
  const sb = createServiceClient();
  const { data: pedidos, error } = await sb
    .from("siso_pedidos")
    .select("id, empresa_origem_id, id_pedido_ecommerce, prazo_envio")
    .eq("nome_ecommerce", "Mercado Livre")
    .not("id_pedido_ecommerce", "is", null)
    .order("criado_em", { ascending: false })
    .limit(LIMITE);
  if (error) throw error;

  console.log(`${pedidos?.length ?? 0} pedidos ML${DRY ? " (DRY RUN)" : ""}\n`);

  // cache empresa_id → connId (evita lookup repetido)
  const connCache = new Map<string, string | null>();
  let atualizados = 0,
    semSla = 0,
    semConn = 0,
    erros = 0;

  for (const p of pedidos ?? []) {
    const empresaId = p.empresa_origem_id as string | null;
    const orderId = p.id_pedido_ecommerce as string | null;
    if (!empresaId || !orderId) {
      semConn++;
      continue;
    }
    try {
      if (!connCache.has(empresaId)) {
        connCache.set(empresaId, await getActiveMlConnectionForEmpresa(empresaId));
      }
      const connId = connCache.get(empresaId)!;
      if (!connId) {
        semConn++;
        continue;
      }
      const sla = await getMlShipmentSla(connId, orderId);
      if (!sla?.expectedDate) {
        semSla++;
        console.log(`  – ${p.id} (ecom ${orderId}): sem SLA`);
        continue;
      }
      if (sla.expectedDate === p.prazo_envio) {
        atualizados++; // já igual, conta como ok mas não escreve
        console.log(`  = ${p.id}: já ${sla.expectedDate}`);
        continue;
      }
      if (!DRY) {
        const { error: upErr } = await sb
          .from("siso_pedidos")
          .update({ prazo_envio: sla.expectedDate })
          .eq("id", p.id);
        if (upErr) throw upErr;
      }
      atualizados++;
      console.log(`  ✓ ${p.id}: ${p.prazo_envio ?? "NULL"} → ${sla.expectedDate}`);
    } catch (err) {
      erros++;
      console.error(`  ✗ ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `\nResumo: ${atualizados} atualizados/ok · ${semSla} sem SLA · ${semConn} sem conexão · ${erros} erros`,
  );
}
main().catch((e) => { console.error(e); process.exit(1); });
