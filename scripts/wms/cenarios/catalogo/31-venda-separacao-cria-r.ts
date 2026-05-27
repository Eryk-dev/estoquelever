import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "31 — Venda modo separação cria R (não corre risco vs marketplace)",
  descricao:
    "Vendedor cria venda modo=separacao. Deve criar R no ledger pra cada item " +
    "(WMS_AS_SOURCE). Senão marketplace concorrente pode pegar saldo e baixa " +
    "do vendedor falha.",
  tags: ["vendas", "separacao", "reserva", "ledger"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("31");
    await ctx.criarProduto({ sku, descricao: "Venda-Sep 31" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 4 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const v = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 2 }],
      modo: "separacao",
    });
    if (v.degradado) {
      throw new Error(`venda degradou inesperadamente: ${v.motivo_degradacao}`);
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo intacto (R não baixa saldo)
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 4);
    // Reservado = 2 (R foi criada pelo vendas/criar modo separacao)
    await ctx.assertReservado(sku, "CWB", "A-01-01", 2);
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
