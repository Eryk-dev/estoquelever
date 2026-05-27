#!/usr/bin/env tsx
/**
 * scripts/wms/backfill-notas-fiscais.ts
 *
 * Fix-Final A T9 (R5): backfill retroativo de `siso_notas_fiscais` a partir de
 * dados de NF que estavam em `siso_movimentacoes.origem_detalhes` (chave_acesso,
 * numero, serie) mas não tinham `nota_fiscal_id` populado.
 *
 * Após T5/T6/T7/T8, NOVAS movs com origem_tipo NF exigem `nota_fiscal_id` (FK).
 * Movs HISTÓRICAS (antes de 2026-05-27) ficaram com nota_fiscal_id=NULL. Este
 * script:
 *
 * 1. Lê movs com origem_tipo IN (nf_compra|nf_venda|devolucao_*) e nota_fiscal_id IS NULL
 * 2. Pra cada uma, extrai chave_acesso/numero/serie de origem_detalhes (best-effort)
 * 3. Upserta `siso_notas_fiscais` (dedup por chave_acesso UNIQUE) e linka mov via UPDATE
 *
 * Rodar dry-run: npx tsx scripts/wms/backfill-notas-fiscais.ts
 * Rodar real:    npx tsx scripts/wms/backfill-notas-fiscais.ts --apply
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const sb = createClient(supabaseUrl, serviceKey);

const NF_ORIGENS = [
  "nf_compra",
  "nf_venda",
  "devolucao_cliente_integra",
  "devolucao_cliente_avariada",
  "devolucao_fornecedor_recebida",
  "devolucao_fornecedor_enviada",
] as const;

type Mov = {
  id: string;
  origem_tipo: string;
  origem_detalhes: Record<string, unknown> | null;
  empresa_compradora_id: string | null;
  empresa_vendedora_id: string | null;
  empresa_referencia_id: string | null;
};

function tipoFromOrigem(origem: string): "entrada" | "saida" {
  if (origem.startsWith("nf_compra")) return "entrada";
  if (origem.startsWith("devolucao_fornecedor")) return "entrada";
  if (origem.startsWith("devolucao_cliente")) return "entrada";
  return "saida"; // nf_venda
}

function extractChave(det: Record<string, unknown> | null): string | null {
  if (!det) return null;
  const v = det.chave_acesso ?? det.chaveAcesso ?? det.chave_acesso_nf ?? null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function main() {
  console.log(apply ? "🚀 APPLY mode (escreve em siso_notas_fiscais + UPDATE movs)" : "🔍 DRY-RUN mode (use --apply pra gravar)");

  const { data: movs, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_tipo, origem_detalhes, empresa_compradora_id, empresa_vendedora_id, empresa_referencia_id")
    .in("origem_tipo", NF_ORIGENS as unknown as string[])
    .is("nota_fiscal_id", null)
    .limit(5000);

  if (error) {
    console.error("erro buscando movs:", error.message);
    process.exit(1);
  }

  const movList = (movs ?? []) as Mov[];
  console.log(`📊 Movs candidatas: ${movList.length}`);

  let created = 0;
  let linked = 0;
  let skipped_sem_chave = 0;
  let erro_count = 0;

  for (const mov of movList) {
    const chave = extractChave(mov.origem_detalhes);
    if (!chave) {
      skipped_sem_chave++;
      continue;
    }
    const tipo = tipoFromOrigem(mov.origem_tipo);
    const empresaId =
      mov.empresa_compradora_id ??
      mov.empresa_vendedora_id ??
      mov.empresa_referencia_id ??
      null;

    if (!apply) {
      linked++;
      continue;
    }

    try {
      let nfId: string | null = null;
      const { data: existing } = await sb
        .from("siso_notas_fiscais")
        .select("id")
        .eq("chave_acesso", chave)
        .maybeSingle();
      if (existing) {
        nfId = (existing as { id: string }).id;
      } else {
        const { data: ins, error: errIns } = await sb
          .from("siso_notas_fiscais")
          .insert({
            chave_acesso: chave,
            numero: (mov.origem_detalhes?.numero as string) ?? null,
            serie: (mov.origem_detalhes?.serie as string) ?? null,
            empresa_id: empresaId,
            tipo,
            raw_tiny: mov.origem_detalhes,
          })
          .select("id")
          .single();
        if (errIns) throw new Error(`insert NF: ${errIns.message}`);
        nfId = (ins as { id: string }).id;
        created++;
      }

      const { error: errUpd } = await sb
        .from("siso_movimentacoes")
        .update({ nota_fiscal_id: nfId })
        .eq("id", mov.id);
      if (errUpd) throw new Error(`update mov: ${errUpd.message}`);
      linked++;
    } catch (e) {
      erro_count++;
      console.error(`  ❌ mov=${mov.id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  console.log("");
  console.log("✅ Backfill done");
  console.log(`   created=${created}  linked=${linked}  skipped_sem_chave=${skipped_sem_chave}  erros=${erro_count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
