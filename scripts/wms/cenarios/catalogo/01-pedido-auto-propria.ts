import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "01 — Pedido auto-aprovado própria",
  descricao: "Webhook NetAir, saldo total em CWB, auto-aprovação, picking completo, embalagem, expedição.",
  tags: ["pedido", "auto", "propria", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("01");
    await ctx.criarProduto({ sku, descricao: "Filtro 01" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido", undefined, { timeout_ms: 8_000 }); // auto-aprovado
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado");
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 2);
    await ctx.assertMovsCount(sku, 2); // 1 E seed + 1 S
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
