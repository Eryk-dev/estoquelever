import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "05 — Parcial esgota → encaminhar",
  descricao: "Cascade esgota cobertura em CWB; operador encaminha pra SP.",
  tags: ["separacao", "parcial", "realocacao", "encaminhar"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("05");
    await ctx.criarProduto({ sku, descricao: "Esgota 05" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-03", qty: 2 });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-02", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 5 }] });
    await ctx.aguardarStatus(pedido.id, "pendente"); // não auto-aprova: cobertura parcial
    await ctx.aprovar(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 2, loc_zerou: true });
    // cascade não tem mais loc CWB com saldo > deve abrir caminho de encaminhar
    await ctx.encaminhar({ pedido: pedido.id, item: sku, galpao_destino: "SP" });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-03", 0);
    // Encaminhar gera pedido novo em SP; valida indiretamente via mov S em A-01-03
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
