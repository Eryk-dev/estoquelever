/**
 * Seed inicial do módulo Cross.
 *
 * Lê tabelas do projeto externo cross (mesmo banco Supabase wrbrbhuhsaaupqsimkqz):
 *   - cross.products       → siso_produtos_catalogo
 *   - cross.oem_metadata   → marca origem='manual' nos OEMs correspondentes
 *
 * Idempotente: pode rodar várias vezes; usa UPSERT.
 *
 * Uso:
 *   npx tsx scripts/seed-cross-catalogo.ts
 *   ou
 *   npm run seed:cross
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

// Carrega .env.local explicitamente (ts-node fora do Next.js não carrega automaticamente)
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY no .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const PAGE_SIZE = 500;

async function main() {
  console.log("[seed] iniciando seed do módulo Cross");

  // ----- 1. Importar produtos -----
  let totalProdutos = 0;
  let offset = 0;
  while (true) {
    const { data: produtos, error } = await supabase
      .from("products")
      .select(
        "sku, tiny_id, product_name, description, supplier, manufacturer, pictures, oem, gtin",
      )
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("[seed] erro lendo cross.products:", error.message);
      process.exit(1);
    }
    if (!produtos || produtos.length === 0) break;

    const linhas = produtos.map((p: any) => ({
      sku: p.sku,
      tiny_id: p.tiny_id ? Number(p.tiny_id) : null,
      nome: p.product_name ?? p.sku,
      descricao: p.description ?? null,
      fornecedor: p.supplier ?? null,
      marca: p.manufacturer ?? null,
      imagem_url:
        Array.isArray(p.pictures) && p.pictures.length > 0 ? p.pictures[0] : null,
      gtin: p.gtin ?? null,
      sincronizado_em: new Date().toISOString(),
    }));

    const { error: upErr } = await supabase
      .from("siso_produtos_catalogo")
      .upsert(linhas, { onConflict: "sku" });

    if (upErr) {
      console.error("[seed] erro no upsert de produtos:", upErr.message);
      process.exit(1);
    }

    totalProdutos += produtos.length;
    console.log(`[seed] produtos importados: ${totalProdutos}`);
    offset += PAGE_SIZE;
    if (produtos.length < PAGE_SIZE) break;
  }

  // ----- 2. Importar OEMs (todos como extracao_tiny inicialmente) -----
  let totalOems = 0;
  offset = 0;
  while (true) {
    const { data: produtos, error } = await supabase
      .from("products")
      .select("sku, oem")
      .range(offset, offset + PAGE_SIZE - 1);

    if (error || !produtos || produtos.length === 0) break;

    const oemRows: Array<{
      produto_sku: string;
      oem_code: string;
      origem: "extracao_tiny";
      adicionado_por: null;
    }> = [];

    for (const p of produtos as any[]) {
      const oems = Array.isArray(p.oem) ? p.oem : [];
      for (const code of oems) {
        if (typeof code === "string" && code.trim()) {
          oemRows.push({
            produto_sku: p.sku,
            oem_code: code.toUpperCase().trim(),
            origem: "extracao_tiny",
            adicionado_por: null,
          });
        }
      }
    }

    if (oemRows.length > 0) {
      const { error: oemErr } = await supabase
        .from("siso_produto_oems")
        .upsert(oemRows, {
          onConflict: "produto_sku,oem_code",
          ignoreDuplicates: true,
        });

      if (oemErr) {
        console.error("[seed] erro no upsert de OEMs:", oemErr.message);
        process.exit(1);
      }
      totalOems += oemRows.length;
    }

    offset += PAGE_SIZE;
    if (produtos.length < PAGE_SIZE) break;
  }
  console.log(
    `[seed] OEMs importados (potencialmente duplicados eliminados): ${totalOems}`,
  );

  // ----- 3. Marcar OEMs manuais via cross.oem_metadata -----
  const { data: metadata } = await supabase
    .from("oem_metadata")
    .select("sku, oem_code, added_by_email");

  let totalManuaisMarcados = 0;
  for (const meta of (metadata ?? []) as any[]) {
    let userId: string | null = null;
    if (meta.added_by_email) {
      const { data: user } = await supabase
        .from("siso_usuarios")
        .select("id")
        .eq("email", meta.added_by_email)
        .maybeSingle();
      userId = user?.id ?? null;
    }
    const { error: updErr } = await supabase
      .from("siso_produto_oems")
      .update({ origem: "manual", adicionado_por: userId })
      .eq("produto_sku", meta.sku)
      .eq("oem_code", meta.oem_code);
    if (!updErr) totalManuaisMarcados++;
  }
  console.log(`[seed] OEMs marcados como manuais: ${totalManuaisMarcados}`);

  // ----- 4. Importar veículos (compatibility_v2) -----
  let totalVeiculos = 0;
  offset = 0;
  while (true) {
    const { data: produtos, error } = await supabase
      .from("products")
      .select("sku, compatibility_v2")
      .range(offset, offset + PAGE_SIZE - 1);

    if (error || !produtos || produtos.length === 0) break;

    const veiculoRows: Array<{
      produto_sku: string;
      marca: string;
      modelo: string;
      ano_inicio: number | null;
      ano_fim: number | null;
      variante: string | null;
      adicionado_por: null;
    }> = [];

    for (const p of produtos as any[]) {
      const vehicles = p.compatibility_v2?.vehicles;
      if (!Array.isArray(vehicles)) continue;
      for (const v of vehicles) {
        if (!v.brand || !v.model) continue;
        veiculoRows.push({
          produto_sku: p.sku,
          marca: String(v.brand).toUpperCase().trim(),
          modelo: String(v.model).toUpperCase().trim(),
          ano_inicio: v.year_start ? Number(v.year_start) : null,
          ano_fim: v.year_end ? Number(v.year_end) : null,
          variante: v.variant ? String(v.variant).trim() : null,
          adicionado_por: null,
        });
      }
    }

    if (veiculoRows.length > 0) {
      const { error: vErr } = await supabase
        .from("siso_produto_veiculos")
        .upsert(veiculoRows, {
          onConflict: "produto_sku,marca,modelo,ano_inicio,ano_fim,variante",
          ignoreDuplicates: true,
        });

      if (vErr) {
        console.error("[seed] erro no upsert de veículos:", vErr.message);
        process.exit(1);
      }
      totalVeiculos += veiculoRows.length;
    }

    offset += PAGE_SIZE;
    if (produtos.length < PAGE_SIZE) break;
  }
  console.log(
    `[seed] veículos importados (potencialmente duplicados eliminados): ${totalVeiculos}`,
  );

  console.log("[seed] CONCLUÍDO");
  console.log({
    produtos: totalProdutos,
    oems_extracao_tiny: totalOems,
    oems_manuais_marcados: totalManuaisMarcados,
    veiculos: totalVeiculos,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
