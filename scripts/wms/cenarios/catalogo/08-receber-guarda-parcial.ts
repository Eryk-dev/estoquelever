import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "08 — Receber → Guarda parcial → Pendência",
  descricao: "Receber 50 no dock; guardar 30 em A-01-06; pendência fica com 20; guardar resto depois em B-02-01.",
  tags: ["receber", "guarda", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("08");
    await ctx.criarProduto({ sku, descricao: "Receb 08" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const res = await ctx.receber({ galpao: "CWB", items: [{ sku, qty: 50 }] });
    const pendId = res.pendencias[0];
    await ctx.guardar({ pendencia_id: pendId, loc_destino: "A-01-06", qty: 30 });
    await ctx.aguardarPendenciaGuarda(pendId, "pendente"); // ainda tem 20
    await ctx.guardar({ pendencia_id: pendId, loc_destino: "B-02-01", qty: 20 });
    await ctx.aguardarPendenciaGuarda(pendId, "guardada");
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-06", 30);
    await ctx.assertSaldo(sku, "CWB", "B-02-01", 20);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 0);
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
