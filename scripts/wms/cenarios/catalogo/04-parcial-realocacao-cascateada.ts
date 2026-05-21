import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "04 — Parcial + realocação cascateada",
  descricao: "Bipa 3/5, loc zerou, cascade pega 2/2 em outra loc, finaliza.",
  tags: ["separacao", "parcial", "realocacao", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("04");
    await ctx.criarProduto({ sku, descricao: "Realoc 04" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 2 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 5 }] });
    await ctx.aguardarStatus(pedido.id, "concluido"); // auto
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 3, loc_zerou: true });
    await ctx.aguardarRealocacao(pedido.id, sku, "A-01-02");
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 2 });
    await ctx.concluirSeparacao(pedido.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 0);
    await ctx.assertMovsCount(sku, 4); // 2 E (seed) + 2 S (picking em 2 locs)
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
