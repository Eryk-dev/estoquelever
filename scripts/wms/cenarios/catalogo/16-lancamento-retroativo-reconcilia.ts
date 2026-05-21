import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "16 — Lançamento retroativo + reconcilia",
  descricao: "Registra pendência retroativa; chega mov real; reconcilia zera pendência.",
  tags: ["retroativo", "reconciliacao", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("16");
    await ctx.criarProduto({ sku, descricao: "Retro 16" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pend = await ctx.lancamentoRetroativo({ sku, galpao: "CWB", loc: "A-01-01", qty: 5, tipo: "E" });
    // Mov "real" chega via receber direto
    await ctx.receber({
      galpao: "CWB",
      items: [{ sku, qty: 5, loc_destino: "A-01-01" }],
      entrada_direta: true,
    });
    await ctx.reconciliarRetroativo(pend.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 5);
    // Status pós-reconciliação validado pelos invariantes globais (I1/I7).
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
