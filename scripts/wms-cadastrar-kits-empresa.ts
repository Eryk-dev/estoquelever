/**
 * Cadastra a composição dos kits de uma empresa no WMS.
 *
 * Pra cada produto mapeado da empresa que parece kit (sufixo -X<N> ou já
 * marcado eh_kit=true sem composição), busca a composição no Tiny via
 * GET /produtos/{id} (que devolve `tipo` e `kit[]` na mesma chamada),
 * resolve cada componente em siso_produtos (via siso_produto_empresas) e
 * grava em siso_produto_kits. Marca siso_produtos.eh_kit=true.
 *
 * Uso:
 *   npx tsx scripts/wms-cadastrar-kits-empresa.ts EasyPeasy
 *   npx tsx scripts/wms-cadastrar-kits-empresa.ts EasyPeasy --all
 *   npx tsx scripts/wms-cadastrar-kits-empresa.ts EasyPeasy --sku=TEN001-3-X3
 *
 * --all  : varre todos os produtos mapeados (custoso, ~2k chamadas)
 * --sku=X: roda só pra um SKU específico (debug)
 * Default: filtra por sufixo -X<N> OU eh_kit=true (mais barato)
 *
 * Requer .env.local com NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import "dotenv/config";
import { createServiceClient } from "../src/lib/supabase-server";
import { getValidTokenByEmpresa } from "../src/lib/tiny-oauth";
import { getProdutoFull } from "../src/lib/tiny-api";

interface ProdutoMapeado {
  tiny_produto_id: number;
  produto_id: string;
  sku: string;
  descricao: string;
  eh_kit: boolean;
}

interface KitInfo {
  produto_id: string;
  tiny_produto_id: number;
  sku: string;
  composicao: Array<{
    componente_tiny_id: number;
    componente_sku: string | null;
    quantidade: number;
  }>;
}

const TINY_REQ_DELAY_MS = 600; // conservador (~100 req/min)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function listarProdutosCandidatos(
  empresaId: string,
  modo: "filtrado" | "all",
  skuEspecifico: string | null,
): Promise<ProdutoMapeado[]> {
  const sb = createServiceClient();
  const PAGE = 1000;
  let offset = 0;
  const all: ProdutoMapeado[] = [];

  while (true) {
    let q = sb
      .from("siso_produto_empresas")
      .select(
        "tiny_produto_id, produto_id, produto:siso_produtos!inner(sku, descricao, eh_kit)",
      )
      .eq("empresa_id", empresaId)
      .range(offset, offset + PAGE - 1);

    if (skuEspecifico) {
      q = q.eq("produto.sku", skuEspecifico);
    }

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const r of data) {
      const row = r as unknown as {
        tiny_produto_id: number;
        produto_id: string;
        produto: { sku: string; descricao: string; eh_kit: boolean } | null;
      };
      if (!row.produto) continue;
      all.push({
        tiny_produto_id: Number(row.tiny_produto_id),
        produto_id: row.produto_id,
        sku: row.produto.sku,
        descricao: row.produto.descricao,
        eh_kit: row.produto.eh_kit ?? false,
      });
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  if (skuEspecifico || modo === "all") return all;

  // Filtro local: sufixo -X<N>$ OU já marcado como kit
  const re = /-X[0-9]+$/;
  return all.filter((p) => p.eh_kit || re.test(p.sku));
}

async function buscarKitDoTiny(
  token: string,
  produto: ProdutoMapeado,
): Promise<KitInfo | null> {
  const detalhe = await getProdutoFull(token, produto.tiny_produto_id);
  if (detalhe.tipo !== "K") return null;
  if (!detalhe.kit || detalhe.kit.length === 0) return null;
  return {
    produto_id: produto.produto_id,
    tiny_produto_id: produto.tiny_produto_id,
    sku: produto.sku,
    composicao: detalhe.kit.map((k) => ({
      componente_tiny_id: k.produto.id,
      componente_sku: k.produto.sku,
      quantidade: k.quantidade,
    })),
  };
}

async function resolverComponenteWms(
  empresaId: string,
  componenteTinyId: number,
): Promise<string | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_produto_empresas")
    .select("produto_id")
    .eq("empresa_id", empresaId)
    .eq("tiny_produto_id", componenteTinyId)
    .maybeSingle();
  return data?.produto_id ?? null;
}

async function gravarComposicao(
  kit: KitInfo,
  empresaId: string,
): Promise<{ ok: number; faltando: number }> {
  const sb = createServiceClient();

  // 1. Marca o produto como kit
  await sb
    .from("siso_produtos")
    .update({ eh_kit: true })
    .eq("id", kit.produto_id);

  // 2. Resolve cada componente em paralelo
  const resolvidos = await Promise.all(
    kit.composicao.map(async (c) => ({
      ...c,
      componente_produto_id: await resolverComponenteWms(
        empresaId,
        c.componente_tiny_id,
      ),
    })),
  );

  const presentes = resolvidos.filter((r) => r.componente_produto_id);
  const faltando = resolvidos.length - presentes.length;

  if (presentes.length === 0) return { ok: 0, faltando };

  // 3. Limpa composição antiga e insere a nova (idempotência simples)
  await sb.from("siso_produto_kits").delete().eq("kit_produto_id", kit.produto_id);

  const rows = presentes.map((r) => ({
    kit_produto_id: kit.produto_id,
    componente_produto_id: r.componente_produto_id as string,
    quantidade: r.quantidade,
  }));

  const { error: insErr } = await sb.from("siso_produto_kits").insert(rows);
  if (insErr) throw insErr;

  return { ok: presentes.length, faltando };
}

async function main() {
  const args = process.argv.slice(2);
  const empresaNome = args[0];
  const modo: "filtrado" | "all" = args.includes("--all") ? "all" : "filtrado";
  const skuArg = args.find((a) => a.startsWith("--sku="));
  const skuEspecifico = skuArg ? skuArg.slice("--sku=".length) : null;

  if (!empresaNome) {
    console.error("Uso: npx tsx scripts/wms-cadastrar-kits-empresa.ts <Empresa> [--all] [--sku=X]");
    process.exit(1);
  }

  const sb = createServiceClient();
  const { data: emp, error: empErr } = await sb
    .from("siso_empresas")
    .select("id, nome")
    .eq("nome", empresaNome)
    .maybeSingle();
  if (empErr || !emp) {
    console.error(`Empresa "${empresaNome}" não encontrada.`);
    process.exit(1);
  }

  console.log(`▸ Empresa: ${emp.nome} (${emp.id})`);
  console.log(`▸ Modo: ${modo}${skuEspecifico ? ` (--sku=${skuEspecifico})` : ""}`);

  const { token } = await getValidTokenByEmpresa(emp.id);
  console.log(`▸ Token Tiny obtido.\n`);

  const candidatos = await listarProdutosCandidatos(emp.id, modo, skuEspecifico);
  console.log(`▸ ${candidatos.length} produtos candidatos a kit. Consultando Tiny...\n`);

  let kitsEncontrados = 0;
  let composicoesGravadas = 0;
  let componentesFaltando = 0;
  let erros = 0;
  let naoEhKit = 0;

  for (let i = 0; i < candidatos.length; i++) {
    const p = candidatos[i];
    process.stdout.write(
      `\r  [${i + 1}/${candidatos.length}] ${p.sku.padEnd(20)} `,
    );
    try {
      const kitInfo = await buscarKitDoTiny(token, p);
      if (!kitInfo) {
        naoEhKit++;
        await sleep(TINY_REQ_DELAY_MS);
        continue;
      }
      kitsEncontrados++;
      const result = await gravarComposicao(kitInfo, emp.id);
      composicoesGravadas += result.ok;
      componentesFaltando += result.faltando;
      console.log(
        `→ KIT (${result.ok} componentes ok, ${result.faltando} faltando)`,
      );
    } catch (err) {
      erros++;
      console.log(`→ ERRO: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(TINY_REQ_DELAY_MS);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✓ Kits identificados:       ${kitsEncontrados}`);
  console.log(`✓ Componentes cadastrados:  ${composicoesGravadas}`);
  console.log(`⚠ Componentes faltando:     ${componentesFaltando}`);
  console.log(`  Não-kits descartados:     ${naoEhKit}`);
  console.log(`  Erros:                    ${erros}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (componentesFaltando > 0) {
    console.log(
      `\n⚠ "Componentes faltando" = componentes que não estão em siso_produto_empresas pra ${emp.nome}. Tem que cadastrar o produto base primeiro (sync com Tiny) antes de relincar.`,
    );
  }
}

main().catch((e) => {
  console.error("\n", e);
  process.exit(1);
});
