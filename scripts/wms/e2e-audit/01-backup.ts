/**
 * E2E AUDIT — Passo 1: BACKUP (rede de segurança)
 *
 * Dump full das tabelas de ESTADO operacional pra JSON. Não toca em nada.
 * Pula tabelas de log puro (siso_logs/erros/webhook_logs/api_calls): append-only,
 * limpas por correlation_id no cleanup, não precisam restore.
 *
 * Uso: npx tsx scripts/wms/e2e-audit/01-backup.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

import { writeFileSync, mkdirSync } from "fs";
import { createServiceClient } from "../../../src/lib/supabase-server";

const STAGING = "ehbxpbeijofxtsbezwxd";
const DIR = "scripts/wms/e2e-audit/_out/backup";

const STATE_TABLES = [
  "siso_movimentacoes",
  "siso_estoque",
  "siso_custo_medio",
  "siso_pedidos",
  "siso_pedido_itens",
  "siso_pedido_item_mov_links",
  "siso_fila_execucao",
  "siso_wms_pendencias_guarda",
  "siso_ordens_compra",
  "siso_devolucoes_pendentes",
  "siso_trocas_equivalencia",
  "siso_notas_fiscais",
  "siso_compras_manuais",
  "siso_compras_manuais_itens",
  "siso_impressoes_log",
  "siso_localizacao_locks",
  "siso_transferencias_galpao",
  "siso_transferencias_galpao_itens",
  "siso_inventario_sessoes",
  "siso_inventario_operadores",
  "siso_inventario_localizacoes",
  "siso_inventario_contagens",
  "siso_inventario_divergencias",
];

async function dumpTable(sb: any, t: string): Promise<{ table: string; rows: number; skipped?: string }> {
  const all: any[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await sb.from(t).select("*").range(from, from + page - 1);
    if (error) {
      // tabela pode não existir nessa versão de schema — registra e segue
      return { table: t, rows: 0, skipped: error.message };
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < page) break;
    from += page;
  }
  writeFileSync(`${DIR}/${t}.json`, JSON.stringify(all));
  return { table: t, rows: all.length };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes(STAGING)) throw new Error(`ABORT: URL não é staging. Atual: ${url}`);
  mkdirSync(DIR, { recursive: true });
  const sb = createServiceClient();
  const manifest: any = { staging: STAGING, at: new Date().toISOString(), tables: [] };
  console.log(`\n=== BACKUP → ${DIR} ===`);
  for (const t of STATE_TABLES) {
    const r = await dumpTable(sb, t);
    manifest.tables.push(r);
    console.log(`  ${t.padEnd(36)} ${r.skipped ? "SKIP (" + r.skipped + ")" : r.rows + " linhas"}`);
  }
  writeFileSync(`${DIR}/_manifest.json`, JSON.stringify(manifest, null, 2));
  const total = manifest.tables.reduce((s: number, t: any) => s + t.rows, 0);
  console.log(`\n✅ backup completo: ${total} linhas em ${manifest.tables.length} tabelas\n`);
}

main().catch((e) => {
  console.error("backup fatal:", e);
  process.exit(1);
});
