/**
 * Backfill: pedidos com etiqueta RASTER (~DG, ex. Shopee) cujos códigos não
 * estão em siso_pedidos.etiqueta_barcodes. Decodifica os barcodes/QR do bitmap
 * e mescla no array (dedup). Idempotente. Não toca em etiqueta_zpl.
 *
 *   npm run backfill:barcodes-raster            # dry-run (só mostra)
 *   npm run backfill:barcodes-raster -- --apply # grava
 *
 * (sem entrada em package.json: rodar via `tsx scripts/wms/backfill-barcodes-raster.ts`)
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { extrairBarcodesDoRaster } from "../../src/lib/etiqueta-barcode-raster";
import { montarBarcodesEtiqueta } from "../../src/lib/etiqueta-barcode";

const APPLY = process.argv.includes("--apply");

async function main() {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_pedidos")
    .select("id, numero, nome_ecommerce, etiqueta_zpl, etiqueta_barcodes")
    .ilike("etiqueta_zpl", "%~DG%")
    .returns<
      Array<{
        id: string;
        numero: string | null;
        nome_ecommerce: string | null;
        etiqueta_zpl: string | null;
        etiqueta_barcodes: string[] | null;
      }>
    >();

  if (error) throw new Error(error.message);
  console.log(`${data?.length ?? 0} pedidos com etiqueta raster (~DG)\n`);

  let alterados = 0;
  for (const p of data ?? []) {
    const doRaster = await extrairBarcodesDoRaster(p.etiqueta_zpl);
    const atual = p.etiqueta_barcodes ?? [];
    // mescla atual + raster, dedup
    const novo = montarBarcodesEtiqueta(null, [...atual, ...doRaster]);
    const mudou =
      novo.length !== atual.length || novo.some((b) => !atual.includes(b));

    if (!mudou) {
      console.log(`#${p.numero ?? p.id} [${p.nome_ecommerce}] — ok (${atual.length})`);
      continue;
    }
    alterados++;
    console.log(
      `#${p.numero ?? p.id} [${p.nome_ecommerce}] — ${atual.length} → ${novo.length}: ${JSON.stringify(novo)}`,
    );
    if (APPLY) {
      const { error: upErr } = await sb
        .from("siso_pedidos")
        .update({ etiqueta_barcodes: novo })
        .eq("id", p.id);
      if (upErr) console.error(`  ERRO ao gravar #${p.id}: ${upErr.message}`);
    }
  }

  console.log(`\n${alterados} pedido(s) ${APPLY ? "atualizados" : "a atualizar (dry-run)"}`);
  if (!APPLY && alterados > 0) console.log("Rode com --apply pra gravar.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
