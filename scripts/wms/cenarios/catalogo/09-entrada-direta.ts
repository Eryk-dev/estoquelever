import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "09 — Entrada direta",
  descricao: "entrada_direta=true pula RECEBIMENTO; 1 mov direto na loc destino.",
  tags: ["receber", "entrada_direta", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("09");
    await ctx.criarProduto({ sku, descricao: "Direta 09" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    await ctx.receber({
      galpao: "CWB",
      items: [{ sku, qty: 12, loc_destino: "A-01-07" }],
      entrada_direta: true,
    });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-07", 12);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 0);
    await ctx.assertMovsCount(sku, 1); // 1 mov direta, sem par S+E
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
