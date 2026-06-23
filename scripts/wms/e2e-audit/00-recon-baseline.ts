/**
 * E2E AUDIT — Passo 0: recon + baseline (READ-ONLY, zero escrita)
 *
 * - Conta linhas das tabelas operacionais (dimensiona o backup).
 * - Roda os invariantes HARD de estoque (I1 ledger↔cache, I8 reservado↔ledger,
 *   I2 disponivel) contra o dado VIVO de staging.
 * - I1/I2/I8 devem valer pra TODA linha — qualquer violação aqui é bug REAL
 *   já existente no estoque (não causado por teste). Vira baseline + report.
 *
 * Uso: npx tsx scripts/wms/e2e-audit/00-recon-baseline.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

import { writeFileSync } from "fs";
import { createServiceClient } from "../../../src/lib/supabase-server";

const STAGING = "ehbxpbeijofxtsbezwxd";

const OPERACIONAIS = [
  "siso_movimentacoes",
  "siso_estoque",
  "siso_custo_medio",
  "siso_pedidos",
  "siso_pedido_itens",
  "siso_fila_execucao",
  "siso_wms_pendencias_guarda",
  "siso_inventario_sessoes",
  "siso_transferencias_galpao",
  "siso_ordens_compra",
  "siso_devolucoes_pendentes",
  "siso_trocas_equivalencia",
  "siso_notas_fiscais",
  "siso_pedido_item_mov_links",
  "siso_compras_manuais",
  "siso_impressoes_log",
  "siso_localizacao_locks",
  "siso_webhook_logs",
  "siso_logs",
  "siso_erros",
];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes(STAGING)) {
    throw new Error(`ABORT: URL não é staging (${STAGING}). Atual: ${url}`);
  }
  const sb = createServiceClient();
  const out: any = { staging: STAGING, at: new Date().toISOString(), counts: {}, baseline: {} };

  console.log(`\n=== CONTAGENS (staging ${STAGING}) ===`);
  for (const t of OPERACIONAIS) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    if (error) {
      out.counts[t] = `ERRO: ${error.message}`;
      console.log(`  ${t.padEnd(34)} ERRO ${error.message}`);
    } else {
      out.counts[t] = count ?? 0;
      console.log(`  ${t.padEnd(34)} ${count ?? 0}`);
    }
  }

  // ---- watermark do ledger (append-only): maior criado_em + id ----
  const { data: wm } = await sb
    .from("siso_movimentacoes")
    .select("id, criado_em")
    .order("criado_em", { ascending: false })
    .limit(1);
  out.watermark = wm?.[0] ?? null;
  console.log(`\n  watermark ledger: ${JSON.stringify(out.watermark)}`);

  // ---- produtos/pedidos TEST-* já existentes (pra não deletar no cleanup) ----
  const { data: testProds } = await sb.from("siso_produtos").select("id").like("sku", "TEST-%");
  out.preexisting_test_produtos = (testProds ?? []).map((p: any) => p.id);
  console.log(`  produtos TEST-* pré-existentes: ${out.preexisting_test_produtos.length}`);

  console.log(`\n=== INVARIANTES HARD (dado vivo) ===`);

  // I1 — ledger ↔ cache (saldo)
  {
    const { data, error } = await sb.rpc("wms_detectar_divergencias_estoque");
    const linhas = (data as unknown[]) ?? [];
    out.baseline.I1_ledger_vs_cache = error ? { erro: error.message } : { violacoes: linhas.length, amostra: linhas.slice(0, 20) };
    console.log(`  I1 ledger↔cache(saldo): ${error ? "ERRO " + error.message : linhas.length + " divergências"}`);
  }
  // I8 — reservado ↔ ledger
  {
    const { data, error } = await sb.rpc("wms_detectar_divergencias_reservado");
    const linhas = (data as unknown[]) ?? [];
    out.baseline.I8_reservado_vs_ledger = error ? { erro: error.message } : { violacoes: linhas.length, amostra: linhas.slice(0, 20) };
    console.log(`  I8 reservado↔ledger:    ${error ? "ERRO " + error.message : linhas.length + " divergências"}`);
  }
  // I2 — disponivel = saldo - reservado (paginado)
  {
    let from = 0;
    const page = 1000;
    const ruins: any[] = [];
    for (;;) {
      const { data, error } = await sb
        .from("siso_estoque")
        .select("id, produto_id, galpao_id, localizacao_id, saldo, reservado, disponivel")
        .range(from, from + page - 1);
      if (error) { out.baseline.I2_disponivel = { erro: error.message }; break; }
      if (!data || data.length === 0) break;
      for (const r of data as any[]) {
        if (Number(r.disponivel) !== Number(r.saldo) - Number(r.reservado)) ruins.push(r);
        if (Number(r.reservado) > Number(r.saldo)) ruins.push({ ...r, _alerta: "reservado>saldo" });
        if (Number(r.saldo) < 0) ruins.push({ ...r, _alerta: "saldo_negativo" });
        if (Number(r.reservado) < 0) ruins.push({ ...r, _alerta: "reservado_negativo" });
      }
      if (data.length < page) break;
      from += page;
    }
    if (!out.baseline.I2_disponivel) {
      out.baseline.I2_disponivel = { violacoes: ruins.length, amostra: ruins.slice(0, 20) };
      console.log(`  I2 disponivel/saldo>=0: ${ruins.length} linhas ruins`);
    }
  }
  // estoque sem localizacao (a classe do bug recém-corrigido: produto "sem loc")
  {
    const { data, error } = await sb
      .from("siso_estoque")
      .select("id, produto_id, galpao_id, localizacao_id, saldo, reservado")
      .is("localizacao_id", null);
    out.baseline.estoque_sem_loc = error ? { erro: error.message } : { linhas: (data ?? []).length, amostra: (data ?? []).slice(0, 20) };
    console.log(`  estoque sem localizacao: ${error ? "ERRO " + error.message : (data ?? []).length + " linhas"}`);
  }

  writeFileSync("scripts/wms/e2e-audit/_out/00-baseline.json", JSON.stringify(out, null, 2));
  console.log(`\n✅ baseline salvo em scripts/wms/e2e-audit/_out/00-baseline.json\n`);
}

main().catch((e) => {
  console.error("recon fatal:", e);
  process.exit(1);
});
