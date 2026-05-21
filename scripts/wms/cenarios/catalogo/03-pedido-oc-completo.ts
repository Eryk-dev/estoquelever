import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "03 — Pedido OC completo",
  descricao: "Sem estoque em nenhum galpão; pedido vira OC; comprar; receber; guarda; separar.",
  tags: ["pedido", "oc", "compras", "receber", "guarda", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("03");
    await ctx.criarProduto({ sku, descricao: "Item OC 03" });
    // sem semearSaldo — saldo zero em todo lugar
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "oc" });
    await ctx.aprovar(pedido.id, "oc");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_compra");

    const ordem = await ctx.comprar({ sku, qty: 3 });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_nf", { timeout_ms: 6_000 });

    await ctx.receberCompra({ ordem_id: ordem.ordem_id, items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao", { timeout_ms: 8_000 });

    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    // Comprou 3, expediu 3 → saldo final = 0
    await ctx.assertMovsCount(sku, 2); // E (compra) + S (expedição)
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
