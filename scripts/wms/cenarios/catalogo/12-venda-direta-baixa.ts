import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "12 — Venda Direta baixa_direta",
  descricao: "Cria venda modo baixa_direta → 1 mov S origem=venda_manual, saldo cai imediato.",
  tags: ["vendas", "baixa_direta", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("12");
    await ctx.criarProduto({ sku, descricao: "Venda direta 12" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-10", qty: 8 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const r = await ctx.criarVendaDireta({
      galpao: "CWB", empresa: "netair",
      items: [{ sku, qty: 3 }],
      modo: "baixa_direta",
    });
    if (r.degradado) throw new Error(`venda inesperadamente degradada: ${r.motivo_degradacao}`);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-10", 5);
    // 1 E seed + 1 S venda_manual
    await ctx.assertMovsCount(sku, 2);
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
