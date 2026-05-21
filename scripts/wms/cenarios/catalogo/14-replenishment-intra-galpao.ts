import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "14 — Replenishment intra-galpão",
  descricao: "Overstock → picking, par S+E mesma origem_id, custo médio inalterado.",
  tags: ["replenishment", "intra_galpao", "movs"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("14");
    await ctx.criarProduto({ sku, descricao: "Reple 14" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-03", qty: 50, custo: 12 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    await ctx.replenishment({ sku, galpao: "CWB", origem_loc: "B-02-03", destino_loc: "A-01-01", qty: 20 });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "B-02-03", 30);
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 20);
    await ctx.assertCustoMedio(sku, 12, 0.01); // inalterado
    // 1 E seed + 1 S + 1 E (par de replenishment)
    await ctx.assertMovsCount(sku, 3);
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
