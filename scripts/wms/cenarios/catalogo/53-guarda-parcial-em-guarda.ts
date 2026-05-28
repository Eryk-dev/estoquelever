import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "53 — Guarda parcial preserva em_guarda (Fix-D #5.8)",
  descricao:
    "Após confirmar parcial, pendência fica com status 'em_guarda' (não 'pendente'). Garante que o avatar do operador no quadro home persiste mid-flow.",
  tags: ["guarda", "fix-d", "5.8"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("53");
    await ctx.criarProduto({ sku, descricao: "Fix-D guarda em_guarda" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const res = await ctx.receber({ galpao: "CWB", items: [{ sku, qty: 10 }] });
    const pendId = res.pendencias[0];
    // Confirma parcial: 4 de 10
    await ctx.guardar({ pendencia_id: pendId, loc_destino: "A-01-01", qty: 4 });
    // Status deve ser 'em_guarda' (não 'pendente')
    await ctx.aguardarPendenciaGuarda(pendId, "em_guarda");
    // Completa o resto
    await ctx.guardar({ pendencia_id: pendId, loc_destino: "A-01-01", qty: 6 });
    await ctx.aguardarPendenciaGuarda(pendId, "guardada");
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 0);
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

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
