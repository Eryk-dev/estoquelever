import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "10 — Devolução cliente íntegra (A)",
  descricao: "NF entrada categoria A → mov com custo_unitario → siso_custo_medio recalculado.",
  tags: ["devolucao", "categoria_a", "custo_medio", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("10");
    await ctx.criarProduto({ sku, descricao: "Devol A 10" });
    // Estado inicial: 10 unidades compradas a 8 reais
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-08", qty: 10, custo: 8 });

    // Cria NF de devolução simulada (insert direto)
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: dev } = await ctx.sb.from("siso_devolucoes_pendentes").insert({
      galpao_id: ctx.staging.galpoes.cwb.id,
      produto_id: prod!.id,
      quantidade: 2,
      valor_unitario: 14, // valor de venda → vira custo de entrada
      cliente_nome: "Cliente teste",
      status: "aguardando_classificacao",
      chave_acesso_nf: `TEST-NF-${ctx.skuUnico("nf")}`,
    }).select("id").single();

    return { sku, devolucaoId: dev!.id as string };
  },

  run: async (ctx, { devolucaoId }) => {
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "A" });
  },

  assertEsperado: async (ctx, { sku }) => {
    // 10 a 8 + 2 a 14 = (80 + 28) / 12 = 9
    await ctx.assertSaldo(sku, "CWB", "A-01-08", 12);
    await ctx.assertCustoMedio(sku, 9, 0.01);
  },
} satisfies Cenario<{ sku: string; devolucaoId: string }>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  const mod = await import(import.meta.url);
  await runStandalone(mod.default);
}
