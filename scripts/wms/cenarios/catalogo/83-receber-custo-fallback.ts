import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83 — Fallback de custo no recebimento de compra (P104).
 *
 * Produto com custo médio histórico > 0 recebe via compras/receber SEM informar
 * custo_unitario: a entrada deve gravar custo = custo médio histórico (não 0).
 *
 * Papel: regressão smoke do caminho verde end-to-end. O RED da fiação vive no
 * unit src/lib/wms/receber-oc-custo-wiring.test.ts (Step 5). Aqui validamos que
 * o recebimento real não zera o custo médio.
 */

type Setup = { sku: string };

export default {
  nome: "83 — Recebimento de compra sem custo cai pro custo médio histórico (não 0)",
  descricao:
    "Produto com custo médio 10. Recebe via compras/receber sem custo_unitario. " +
    "A entrada usa fallback (10), custo médio não vira 0.",
  tags: ["recebimento", "compras", "custo-medio", "fallback", "P104"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("83");
    await ctx.criarProduto({ sku, descricao: "Custo fallback 83" });
    // Semear saldo com custo 10 → custo médio histórico = 10.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5, custo: 10 });
    return { sku };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Recebe via compras/receber SEM custo_unitario — depende do fallback.
    await ctx.http.post("/api/wms/compras/receber", {
      itens: [{ sku: setup.sku, quantidade_recebida: 5 }],
    });
    await ctx.aguardar(1500);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Custo médio deve permanecer 10 (entrada usou fallback, não 0).
    await ctx.assertCustoMedio(setup.sku, 10, 0.01);
  },
} satisfies Cenario<Setup>;

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
