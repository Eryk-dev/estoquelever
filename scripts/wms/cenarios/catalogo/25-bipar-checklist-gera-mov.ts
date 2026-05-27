import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "25 — bipar-checklist gera par S+L (sem dupla baixa)",
  descricao:
    "Wave-picking via bipar-checklist deve gerar par L+S igual ao marcar-item. " +
    "Sem isso, cutover R→S no concluir duplica a baixa.",
  tags: ["separacao", "bipar-checklist", "ledger"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("25");
    await ctx.criarProduto({ sku, descricao: "Bip checklist 25" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-08", qty: 8 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);

    // Usa /bipar-checklist (não /bipar do item)
    await ctx.http.post("/api/wms/separacao/bipar-checklist", {
      sku,
      pedido_ids: [pedido.id],
    });

    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado");
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo: seed 8 - 2 = 6
    await ctx.assertSaldo(sku, "CWB", "A-01-08", 6);
    // Movs: 1 E (seed) + 1 R (aprovar) + 1 L (bipar-checklist) + 1 S (bipar-checklist) = 4
    await ctx.assertMovsCount(sku, 4);
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
