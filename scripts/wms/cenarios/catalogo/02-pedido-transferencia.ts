import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "02 — Pedido transferência",
  descricao: "NetAir vende, mas estoque está em SP (NetParts). Sistema sugere transferência. Operador aprova.",
  tags: ["pedido", "transferencia", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("02");
    await ctx.criarProduto({ sku, descricao: "Filtro 02" });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-01", qty: 4 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "transferencia" });
    await ctx.aprovar(pedido.id, "transferencia");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 2 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "SP", "C-01-01", 2);
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
