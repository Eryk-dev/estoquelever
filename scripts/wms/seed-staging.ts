/**
 * Onda 2 — Seed staging com produtos sintéticos + saldos consistentes.
 *
 * Esse script:
 *   1. VALIDA que está apontando pra staging (ehbxpbeijofxtsbezwxd) — fail-fast se prod
 *   2. Limpa tabelas de pedidos/movs/estoque/stub-pedidos (mantém catálogo legado intocado)
 *   3. Cria 30 produtos sintéticos em siso_produtos (skip se já existem por SKU)
 *   4. Mapeia tiny_produto_id pra NetAir + NetParts em siso_produto_empresas
 *   5. Lança saldos iniciais via wms_inserir_movimentacao (origem=inventario_inicial)
 *
 * Rodar: `npm run seed:staging`
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { inserirMovimentacao } from "../../src/lib/wms/ledger";
import { PRODUTOS, STAGING_EMPRESAS } from "./cenarios";

const STAGING_PROJECT_REF = "ehbxpbeijofxtsbezwxd";

async function validarSupabaseUrl() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes(STAGING_PROJECT_REF)) {
    throw new Error(
      `🚫 ABORT: NEXT_PUBLIC_SUPABASE_URL não aponta pra staging (${STAGING_PROJECT_REF}). URL atual: ${url}`,
    );
  }
  console.log(`✓ Supabase URL confirmado em staging: ${url}`);
}

async function limparPedidosEstoque() {
  const sb = createServiceClient();

  console.log("\n— Limpando dados sintéticos antigos —");

  // Ordem importa: respeita FKs
  const tabelas = [
    "siso_fila_execucao",
    "siso_pedido_item_estoques",
    "siso_pedido_itens",
    "siso_pedidos",
    "siso_stub_pedidos",
    "siso_webhook_logs",
    "siso_movimentacoes",
    "siso_estoque",
  ];

  for (const tabela of tabelas) {
    const { error, count } = await sb
      .from(tabela)
      .delete({ count: "exact" })
      .gte("criado_em", "1900-01-01"); // truque pra deletar tudo (filtro sempre-true)
    if (error) {
      // alguma tabela pode não ter coluna criado_em — tenta neq id
      const { error: e2, count: c2 } = await sb
        .from(tabela)
        .delete({ count: "exact" })
        .not("id", "is", null);
      if (e2) {
        console.warn(`  ⚠ ${tabela}: ${e2.message}`);
        continue;
      }
      console.log(`  ✓ ${tabela}: ${c2 ?? 0} linhas deletadas`);
    } else {
      console.log(`  ✓ ${tabela}: ${count ?? 0} linhas deletadas`);
    }
  }
}

async function seedProdutos() {
  const sb = createServiceClient();
  console.log("\n— Seed produtos sintéticos —");

  let criados = 0;
  let pulados = 0;
  for (const p of PRODUTOS) {
    const { data: existente } = await sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", p.sku)
      .maybeSingle();

    if (existente?.id) {
      pulados++;
      continue;
    }

    const { error } = await sb.from("siso_produtos").insert({
      sku: p.sku,
      descricao: p.descricao,
      unidade: "UN",
      ativo: true,
    });

    if (error) {
      console.warn(`  ⚠ ${p.sku}: ${error.message}`);
      continue;
    }
    criados++;
  }
  console.log(`  ✓ ${criados} criados / ${pulados} já existiam`);
}

async function seedMapeamentos() {
  const sb = createServiceClient();
  console.log("\n— Seed siso_produto_empresas (mapeamento Tiny IDs) —");

  // Re-busca os IDs criados (UUIDs gerados pelo banco)
  const skus = PRODUTOS.map((p) => p.sku);
  const { data: produtos, error } = await sb
    .from("siso_produtos")
    .select("id, sku")
    .in("sku", skus);

  if (error || !produtos) {
    throw new Error(`Falha ao buscar produtos seedados: ${error?.message}`);
  }

  const produtoIdBySku = new Map(produtos.map((p) => [p.sku, p.id]));

  let criados = 0;
  let pulados = 0;
  for (const p of PRODUTOS) {
    const produtoId = produtoIdBySku.get(p.sku);
    if (!produtoId) continue;

    for (const [empresaKey, tinyId] of [
      [STAGING_EMPRESAS.netair.id, p.tinyIdNetair] as const,
      [STAGING_EMPRESAS.netparts.id, p.tinyIdNetparts] as const,
    ]) {
      const { data: existente } = await sb
        .from("siso_produto_empresas")
        .select("produto_id")
        .eq("produto_id", produtoId)
        .eq("empresa_id", empresaKey)
        .maybeSingle();

      if (existente) {
        pulados++;
        continue;
      }

      const { error: insErr } = await sb.from("siso_produto_empresas").insert({
        produto_id: produtoId,
        empresa_id: empresaKey,
        tiny_produto_id: tinyId,
        ativo: true,
      });

      if (insErr) {
        console.warn(`  ⚠ map ${p.sku} → empresa ${empresaKey}: ${insErr.message}`);
        continue;
      }
      criados++;
    }
  }
  console.log(`  ✓ ${criados} mapeamentos criados / ${pulados} já existiam`);

  return produtoIdBySku;
}

async function seedSaldos(produtoIdBySku: Map<string, string>) {
  console.log("\n— Lançando saldos iniciais via wms_inserir_movimentacao —");

  let lancados = 0;
  let pulados = 0;
  for (const p of PRODUTOS) {
    const produtoId = produtoIdBySku.get(p.sku);
    if (!produtoId) continue;

    // NetAir/CWB
    if (p.saldoCwb > 0) {
      await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoId,
          empresa_dona_id: STAGING_EMPRESAS.netair.id,
          galpao_id: STAGING_EMPRESAS.netair.galpao_id,
          localizacao_id: STAGING_EMPRESAS.netair.default_picking_id,
        },
        tipo: "E",
        qty: p.saldoCwb,
        origem_tipo: "inventario_inicial",
        custo_unitario: 50,
        observacoes: `Seed sintético — ${p.sku} CWB (perfil ${p.perfil})`,
      });
      lancados++;
    } else {
      pulados++;
    }

    // NetParts/SP
    if (p.saldoSp > 0) {
      await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoId,
          empresa_dona_id: STAGING_EMPRESAS.netparts.id,
          galpao_id: STAGING_EMPRESAS.netparts.galpao_id,
          localizacao_id: STAGING_EMPRESAS.netparts.default_picking_id,
        },
        tipo: "E",
        qty: p.saldoSp,
        origem_tipo: "inventario_inicial",
        custo_unitario: 50,
        observacoes: `Seed sintético — ${p.sku} SP (perfil ${p.perfil})`,
      });
      lancados++;
    } else {
      pulados++;
    }
  }
  console.log(`  ✓ ${lancados} movimentações de entrada / ${pulados} sem saldo (esperado)`);
}

/**
 * Cria regras de empréstimo bidirecionais NetAir ↔ NetParts.
 * Sem essas regras, rotearPedidoDoBanco não considera empréstimo
 * entre as empresas e cai em "oc" quando o estoque está só num galpão.
 */
async function seedRegrasEmprestimo() {
  const sb = createServiceClient();
  console.log("\n— Seed regras de empréstimo NetAir ↔ NetParts —");

  const pares: Array<[string, string]> = [
    // [credora, devedora]
    [STAGING_EMPRESAS.netparts.id, STAGING_EMPRESAS.netair.id],
    [STAGING_EMPRESAS.netair.id, STAGING_EMPRESAS.netparts.id],
  ];

  let criadas = 0;
  let puladas = 0;
  for (const [credora, devedora] of pares) {
    const { data: existente } = await sb
      .from("siso_emprestimo_regras")
      .select("id")
      .eq("empresa_credora_id", credora)
      .eq("empresa_devedora_id", devedora)
      .maybeSingle();

    if (existente) {
      puladas++;
      continue;
    }

    const { error } = await sb.from("siso_emprestimo_regras").insert({
      empresa_credora_id: credora,
      empresa_devedora_id: devedora,
      ativo: true,
      permite_emprestimo: true,
      permite_swap: true,
      limites_por_produto: {},
    });

    if (error) {
      console.warn(`  ⚠ regra ${credora}→${devedora}: ${error.message}`);
      continue;
    }
    criadas++;
  }
  console.log(`  ✓ ${criadas} regras criadas / ${puladas} já existiam`);
}

async function relatorioFinal() {
  const sb = createServiceClient();
  console.log("\n— Estado final do seed —");
  const { count: produtos } = await sb
    .from("siso_produtos")
    .select("*", { count: "exact", head: true })
    .like("sku", "19FARTO-%");
  console.log(`  ✓ siso_produtos LIKE '19FARTO-%': ${produtos ?? 0}`);

  const { count: estoque } = await sb
    .from("siso_estoque")
    .select("*", { count: "exact", head: true });
  console.log(`  ✓ siso_estoque (total): ${estoque ?? 0}`);

  const { data: agregado } = await sb
    .from("siso_estoque")
    .select("saldo");
  const totalSaldo = (agregado ?? []).reduce(
    (sum, e) => sum + Number(e.saldo ?? 0),
    0,
  );
  console.log(`  ✓ saldo total em siso_estoque: ${totalSaldo}`);
}

async function main() {
  console.log("=".repeat(60));
  console.log("  WMS CUTOVER — Seed staging");
  console.log("=".repeat(60));

  await validarSupabaseUrl();
  await limparPedidosEstoque();
  await seedProdutos();
  const produtoIdBySku = await seedMapeamentos();
  await seedSaldos(produtoIdBySku);
  await seedRegrasEmprestimo();
  await relatorioFinal();

  console.log("\n✅ Seed concluído. Próximo passo: `npm run seed:cenarios`");
}

main().catch((err) => {
  console.error("\n💥 Seed falhou:", err);
  process.exit(1);
});
