import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "27 — encaminhar libera reserva WMS",
  descricao:
    "Pedido aprovado (R criada). Encaminhar pra outro galpão deve liberar " +
    "a R (via liberarReserva), senão fica órfã. Invariante I4 valida.",
  tags: ["separacao", "encaminhar", "reserva", "ledger"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("27");
    await ctx.criarProduto({ sku, descricao: "Encaminhar 27" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-07", qty: 5 });
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

    await ctx.http.post("/api/wms/separacao/encaminhar", {
      pedido_ids: [pedido.id],
      galpao_destino_id: ctx.staging.galpoes.sp.id,
    });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Reservado deve voltar a 0
    await ctx.assertReservado(sku, "CWB", "A-01-07", 0);
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
