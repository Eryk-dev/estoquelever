#!/usr/bin/env tsx
/**
 * One-off: preenche fornecedor_oc nos itens dos pedidos portados (marcadores
 * @> PORTADO) usando getFornecedorBySku — o import original esqueceu o campo.
 * Idempotente. Rodar: npx tsx scripts/wms/_backfill-fornecedor-portados.ts
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { getFornecedorBySku } from "../../src/lib/sku-fornecedor";

async function main() {
  const sb = createServiceClient();
  const { data: pedidos } = await sb
    .from("siso_pedidos")
    .select("id")
    .contains("marcadores", ["PORTADO"]);
  const ids = (pedidos ?? []).map((p) => p.id as string);
  if (ids.length === 0) {
    console.log("nenhum pedido portado encontrado");
    return;
  }
  const { data: itens } = await sb
    .from("siso_pedido_itens")
    .select("id, sku, fornecedor_oc")
    .in("pedido_id", ids);

  let atualizados = 0;
  for (const it of itens ?? []) {
    const fornecedor = getFornecedorBySku(it.sku as string | null).fornecedor;
    if (it.fornecedor_oc === fornecedor) continue;
    const { error } = await sb
      .from("siso_pedido_itens")
      .update({ fornecedor_oc: fornecedor })
      .eq("id", it.id);
    if (error) console.error(`  ✖ item ${it.id} (${it.sku}): ${error.message}`);
    else atualizados++;
  }
  console.log(`itens portados: ${itens?.length ?? 0} | fornecedor_oc atualizado: ${atualizados}`);
}

main().then(() => process.exit(0));
