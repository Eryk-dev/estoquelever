#!/usr/bin/env tsx
/**
 * One-off (incidente downtime 2026-06): pedidos Shopee que ficaram SEM
 * agrupamento no Tiny (agrupamento_expedicao_id IS NULL) — o fire-and-forget
 * de criarAgrupamentoFase1 nunca rodou (job morto/downtime). Gera o
 * agrupamento agora chamando a MESMA função que o worker usa.
 *
 * criarAgrupamentoFase1 é idempotente + fire-and-forget:
 *  - gate interno: precisa nota_fiscal_id + chave_acesso_nf (self-heal refetch
 *    do Tiny se a chave faltar e a NF já estiver autorizada);
 *  - pula se já tem agrupamento não-'pending';
 *  - "já foi expedida" → cai em expedido_externo + etiqueta via ML.
 *
 *   npx tsx scripts/wms/_gerar-agrupamento-shopee.ts
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { criarAgrupamentoFase1 } from "../../src/lib/agrupamento-service";

async function main() {
  const sb = createServiceClient();

  const { data, error } = await sb
    .from("siso_pedidos")
    .select("id, numero, empresa_origem_id, status_separacao, nota_fiscal_id, chave_acesso_nf, agrupamento_expedicao_id")
    .ilike("nome_ecommerce", "%shopee%")
    .neq("status", "cancelado")
    .is("agrupamento_expedicao_id", null);

  if (error) throw new Error(`query: ${error.message}`);
  const pedidos = data ?? [];

  console.log(`\n${pedidos.length} pedido(s) Shopee sem agrupamento:\n`);
  for (const p of pedidos) {
    console.log(`  ${p.id} (nº ${p.numero})  ${p.status_separacao}  nf=${p.nota_fiscal_id ?? "-"}  chave=${p.chave_acesso_nf ? "sim" : "NÃO"}`);
  }

  console.log(`\n── gerando agrupamento (criarAgrupamentoFase1) ──`);
  for (const p of pedidos) {
    try {
      await criarAgrupamentoFase1(p.id);
      console.log(`  ${p.id}  chamado`);
    } catch (err) {
      console.log(`  ${p.id}  ERRO: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // respeita rate-limit Tiny
  }

  // Re-lê o resultado
  const ids = pedidos.map((p) => p.id);
  const { data: depois } = await sb
    .from("siso_pedidos")
    .select("id, numero, agrupamento_expedicao_id, expedicao_id, chave_acesso_nf, etiqueta_zpl")
    .in("id", ids);

  console.log(`\n── resultado ──`);
  for (const p of depois ?? []) {
    const ag = p.agrupamento_expedicao_id;
    const estado =
      ag && /^\d+$/.test(ag) ? `✅ agrupamento ${ag}` :
      ag === "expedido_externo" ? "↗️ expedido_externo (etiqueta via ML)" :
      ag === "pending" ? "⏳ pending (em voo / re-tentar)" :
      ag ? ag :
      (!p.chave_acesso_nf ? "⚠️ sem chave NF (NF não autorizada — não agrupável ainda)" : "⚠️ continua sem agrupamento");
    console.log(`  ${p.id} (nº ${p.numero})  ${estado}  ${p.etiqueta_zpl ? "[ZPL ok]" : ""}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
