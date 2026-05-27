import type { Cenario, Ctx } from "../_harness/types";

/**
 * B8 step 1 — Replenishment cria mov par S+E (regressão).
 *
 * Semeia 100 unid em loc overstock (A-99-OVER), cria loc picking (A-01-01)
 * com saldo 0. Chama replenishment de 20 unid overstock → picking.
 * Valida que: (a) par S+E foi criado (mov_ids.length === 2),
 * (b) saldo overstock caiu pra 80 e picking subiu pra 20,
 * (c) invariantes I1-I7 passam.
 */
export default {
  nome: "50 — Replenishment cria mov par S+E",
  descricao:
    "Seed 100 overstock + picking vazio, replenishment 20 unid: par S+E criado, overstock=80, picking=20.",
  tags: ["replenishment", "ledger", "regression"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("50");
    await ctx.criarProduto({ sku, descricao: "C50 replenishment cria mov" });

    // Loc overstock para ser a origem
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-99-OVER", tipo: "overstock" });
    await ctx.semearSaldo({
      produto: sku,
      galpao: "CWB",
      loc: "A-99-OVER",
      qty: 100,
      custo: 10,
    });

    // Loc picking destino (saldo 0 — apenas garantir que existe)
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-01-01", tipo: "picking" });

    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    // Replenishment 20 unid overstock → picking
    const repl = await ctx.replenishment({
      sku,
      galpao: "CWB",
      origem_loc: "A-99-OVER",
      destino_loc: "A-01-01",
      qty: 20,
    });

    ctx.log("replenishment", { origem_id: repl.origem_id, mov_ids: repl.mov_ids });

    if (!repl.origem_id) {
      throw new Error("replenishment não retornou origem_id");
    }
    if (repl.mov_ids.length !== 2) {
      throw new Error(
        `esperava par S+E (2 movs), achou ${repl.mov_ids.length} mov(s)`,
      );
    }
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string }) => {
    // Saldo origem (overstock) caiu de 100 para 80
    await ctx.assertSaldo(sku, "CWB", "A-99-OVER", 80);
    // Saldo destino (picking) subiu de 0 para 20
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 20);

    // Total de movs: 1 E (seed) + 1 S + 1 E (par replenishment) = 3
    await ctx.assertMovsCount(sku, 3);
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
