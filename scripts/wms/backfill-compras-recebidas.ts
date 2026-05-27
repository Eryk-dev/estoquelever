#!/usr/bin/env tsx
/**
 * scripts/wms/backfill-compras-recebidas.ts
 *
 * R1 mitigation: cria movs E retroativas pra OCs já recebidas pre-fix do P2.
 *
 * Antes do P2, /api/wms/compras/receber atualizava só
 * siso_pedido_itens.compra_quantidade_recebida sem gravar no ledger. Após o
 * P2, novas chamadas gravam mov E nf_compra. Mas pedidos já recebidos antes
 * têm um "buraco" no ledger — saldo físico não corresponde a siso_estoque.
 *
 * Este script:
 * 1. Lista todos os siso_pedido_itens com compra_quantidade_recebida > 0
 * 2. Verifica se já existe mov E nf_compra associada (origem_id=pedido_id,
 *    origem_detalhes.pedido_item_id=item.id, tipo=E, origem_tipo=nf_compra)
 * 3. Se NÃO existe, cria mov retroativa com:
 *    - tipo=E, origem_tipo=nf_compra
 *    - qty = compra_quantidade_recebida
 *    - loc = RECEBIMENTO do galpão (resolvido via empresa_origem_id)
 *    - empresa_compradora_id = empresa_origem_id
 *    - fornecedor_id = lookup via fornecedor_oc
 *    - custo_unitario = 0 (sem dado histórico)
 *    - motivo = "Backfill P2 — OC recebida pre-fix"
 * 4. Loga skipped items + sucesso + erros
 *
 * Rodar UMA vez após merge do P2 (idempotente — pula items que já têm mov):
 *   npx tsx scripts/wms/backfill-compras-recebidas.ts
 *
 * Dry-run (preview, não escreve):
 *   npx tsx scripts/wms/backfill-compras-recebidas.ts --dry
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { inserirMovimentacao } from "../../src/lib/wms/ledger";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(supabaseUrl, serviceKey);
const dry = process.argv.includes("--dry");

interface ItemRecebido {
  id: number;
  pedido_id: string;
  produto_id: number; // Tiny bigint
  sku: string;
  compra_quantidade_recebida: number;
  fornecedor_oc: string | null;
  siso_pedidos: {
    empresa_origem_id: string | null;
    separacao_galpao_id: string | null;
    nota_fiscal_id: string | null;
  } | null;
}

async function main() {
  console.log(`Backfill compras recebidas — modo: ${dry ? "DRY RUN" : "EXECUTING"}`);

  const { data: items, error } = await sb
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, produto_id, sku, compra_quantidade_recebida, fornecedor_oc, siso_pedidos(empresa_origem_id, separacao_galpao_id, nota_fiscal_id)",
    )
    .gt("compra_quantidade_recebida", 0);
  if (error) {
    console.error("erro ao listar items:", error.message);
    process.exit(1);
  }

  const total = items?.length ?? 0;
  console.log(`Items com compra_quantidade_recebida > 0: ${total}`);

  let criadas = 0;
  let puladas = 0;
  let erros = 0;
  let skipsSemEmpresa = 0;
  let skipsSemMapeamento = 0;
  let skipsSemLoc = 0;

  for (const item of (items ?? []) as unknown as ItemRecebido[]) {
    // Idempotência: verifica se já existe mov E nf_compra pra esse item
    const { data: existentes } = await sb
      .from("siso_movimentacoes")
      .select("id, origem_detalhes")
      .eq("origem_tipo", "nf_compra")
      .eq("origem_id", item.pedido_id)
      .eq("tipo", "E");
    const jaExiste = (existentes ?? []).some((m) => {
      const det = (m.origem_detalhes ?? {}) as { pedido_item_id?: string | number };
      return String(det.pedido_item_id ?? "") === String(item.id);
    });
    if (jaExiste) {
      puladas++;
      continue;
    }

    const empresaOrigemId = item.siso_pedidos?.empresa_origem_id ?? null;
    if (!empresaOrigemId) {
      skipsSemEmpresa++;
      continue;
    }

    let galpaoId = item.siso_pedidos?.separacao_galpao_id ?? null;
    if (!galpaoId) {
      const { data: pref } = await sb
        .from("siso_empresa_galpoes_preferenciais")
        .select("galpao_id")
        .eq("empresa_id", empresaOrigemId)
        .limit(1)
        .maybeSingle();
      galpaoId = (pref?.galpao_id as string | null) ?? null;
    }
    if (!galpaoId) {
      skipsSemEmpresa++;
      continue;
    }

    const { data: map } = await sb
      .from("siso_produto_empresas")
      .select("produto_id")
      .eq("empresa_id", empresaOrigemId)
      .eq("tiny_produto_id", Number(item.produto_id))
      .maybeSingle();
    const produtoWmsId = map?.produto_id as string | undefined;
    if (!produtoWmsId) {
      skipsSemMapeamento++;
      continue;
    }

    const { data: loc } = await sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", galpaoId)
      .eq("tipo", "recebimento")
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();
    const locId = loc?.id as string | undefined;
    if (!locId) {
      skipsSemLoc++;
      continue;
    }

    let fornecedorId: string | null = null;
    if (item.fornecedor_oc) {
      const { data: forn } = await sb
        .from("siso_fornecedores")
        .select("id")
        .eq("nome", item.fornecedor_oc)
        .eq("ativo", true)
        .maybeSingle();
      fornecedorId = (forn?.id as string | null) ?? null;
    }

    if (dry) {
      console.log(
        `[DRY] criaria mov E pedido=${item.pedido_id} item=${item.id} sku=${item.sku} qty=${item.compra_quantidade_recebida} loc=${locId}`,
      );
      criadas++;
      continue;
    }

    try {
      await inserirMovimentacao({
        tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: locId },
        tipo: "E",
        qty: Number(item.compra_quantidade_recebida),
        origem_tipo: "nf_compra",
        origem_id: item.pedido_id,
        origem_detalhes: {
          sku: item.sku,
          pedido_item_id: item.id,
          backfill: true,
          fornecedor_nome: item.fornecedor_oc,
        },
        empresa_compradora_id: empresaOrigemId,
        fornecedor_id: fornecedorId,
        nota_fiscal_id: item.siso_pedidos?.nota_fiscal_id ?? null,
        custo_unitario: 0,
        motivo: `Backfill P2 — OC recebida pre-fix pedido ${item.pedido_id}`,
      });
      criadas++;
      console.log(`OK pedido=${item.pedido_id} item=${item.id} sku=${item.sku} qty=${item.compra_quantidade_recebida}`);
    } catch (e) {
      erros++;
      console.error(`ERRO item=${item.id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  console.log(`\n─── Resumo ───`);
  console.log(`Total items lidos:     ${total}`);
  console.log(`Movs criadas:           ${criadas}`);
  console.log(`Puladas (já tinha mov): ${puladas}`);
  console.log(`Skip sem empresa/galpão: ${skipsSemEmpresa}`);
  console.log(`Skip sem mapeamento:    ${skipsSemMapeamento}`);
  console.log(`Skip sem loc RECEB:     ${skipsSemLoc}`);
  console.log(`Erros:                  ${erros}`);
}

main().catch((e) => {
  console.error("Backfill falhou:", e);
  process.exit(1);
});
