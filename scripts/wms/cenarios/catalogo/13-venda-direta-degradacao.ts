import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "13 — Venda Direta degradação",
  descricao: "Pediu baixa_direta mas faltou saldo → degrada pra aguardando_separacao, response degradado:true.",
  tags: ["vendas", "baixa_direta", "degradacao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("13");
    await ctx.criarProduto({ sku, descricao: "Degrada 13" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-02", qty: 2 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const r = await ctx.criarVendaDireta({
      galpao: "CWB", empresa: "netair",
      items: [{ sku, qty: 5 }], // só tem 2!
      modo: "baixa_direta",
    });
    if (!r.degradado) throw new Error("esperava degradado:true");
    if (r.motivo_degradacao !== "falta_saldo") throw new Error(`motivo errado: ${r.motivo_degradacao}`);
    if (!r.skus_sem_saldo?.includes(sku)) throw new Error(`skus_sem_saldo deveria conter ${sku}: ${JSON.stringify(r.skus_sem_saldo)}`);
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo INTACTO porque degradou — não fez baixa
    await ctx.assertSaldo(sku, "CWB", "B-02-02", 2);
    await ctx.assertMovsCount(sku, 1); // só o seed
  },
} satisfies Cenario<{ sku: string }>;

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
