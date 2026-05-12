// Backfill em batch das imagens dos produtos via Tiny.
// Roda sequencial (rate limit per-empresa é tratado pelo tiny-queue).
// Idempotente: pula produtos que já tem imagens.length > 0.
//
// Uso:
//   npx tsx scripts/wms-backfill-imagens.ts           # processa todos sem imagens
//   npx tsx scripts/wms-backfill-imagens.ts --force   # re-syncrona todos
//   npx tsx scripts/wms-backfill-imagens.ts --limit 50 # limita batch
import "dotenv/config";
import { createServiceClient } from "../src/lib/supabase-server";
import { sincronizarProduto } from "../src/lib/wms/sync-tiny";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const limitIdx = args.indexOf("--limit");
  const limit =
    limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) || 0 : 0;

  const sb = createServiceClient();

  let q = sb
    .from("siso_produtos")
    .select("id, sku, imagens")
    .eq("ativo", true)
    .order("sku", { ascending: true });
  if (!force) q = q.eq("imagens", "{}");
  if (limit > 0) q = q.limit(limit);

  const { data, error } = await q;
  if (error) throw error;
  const produtos = (data ?? []) as Array<{
    id: string;
    sku: string;
    imagens: string[] | null;
  }>;

  console.log(
    `[backfill] ${produtos.length} produto(s) pra processar${
      force ? " (force=true)" : ""
    }`,
  );

  let ok = 0;
  let fail = 0;
  let totalImagens = 0;

  for (let i = 0; i < produtos.length; i++) {
    const p = produtos[i];
    const prefix = `[${i + 1}/${produtos.length}] ${p.sku}`;
    try {
      await sincronizarProduto(p.id);
      const { data: depois } = await sb
        .from("siso_produtos")
        .select("imagens")
        .eq("id", p.id)
        .maybeSingle();
      const n =
        ((depois as { imagens?: string[] } | null)?.imagens ?? []).length;
      totalImagens += n;
      ok++;
      console.log(`${prefix} ✓ ${n} imagem(ns)`);
    } catch (e) {
      fail++;
      console.error(`${prefix} ✗ ${(e as Error).message}`);
    }
  }

  console.log(
    `\n[backfill] concluído: ${ok} OK · ${fail} falha(s) · ${totalImagens} imagem(ns) coletada(s)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
