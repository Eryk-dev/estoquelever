import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "30 — Webhook cancelamento libera R do pedido",
  descricao:
    "Pedido auto-aprovado (R criada). Tiny envia webhook 'cancelado'. " +
    "Deve liberar R via per-R estornarReservaIndividual, senão I4 quebra e " +
    "próximo pedido no mesmo SKU degrada pra OC sem motivo.",
  tags: ["webhook", "cancelamento", "reserva", "ledger"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("30");
    await ctx.criarProduto({ sku, descricao: "Webhook-Cancel 30" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.assertReservado(sku, "CWB", "A-01-01", 2);

    // Tiny webhook cancelamento — formato compatível com /api/wms/webhook/tiny:
    //   tipo ∈ {inclusao_pedido, atualizacao_pedido}
    //   dados.codigoSituacao === "cancelado"
    //   cnpj no top-level pra identificar a empresa.
    await ctx.http.post("/api/wms/webhook/tiny", {
      tipo: "atualizacao_pedido",
      cnpj: ctx.staging.empresas.netair.cnpj,
      dados: {
        id: pedido.id,
        codigoSituacao: "cancelado",
      },
    });

    // O cancelamento é síncrono no handler (não fire-and-forget como o aprovado),
    // mas damos um beat curto pra qualquer trigger/realtime/cache se acomodar
    // antes do assert.
    await ctx.aguardar(500);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);
    await ctx.assertSemReservasOrfas();
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
