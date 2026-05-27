import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "29 — produto-esgotado encaminhar estorna S+L emitidas",
  descricao:
    "Op faz pick → emite S+L → SKU acaba → escolhe encaminhar. " +
    "Movs S+L emitidas devem ser ESTORNADAS antes de trocar galpão. " +
    "Hoje só reseta flags — saldo fica fantasma no galpão antigo.",
  tags: ["separacao", "produto-esgotado", "encaminhar", "estorno"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("29");
    await ctx.criarProduto({ sku, descricao: "Esgotado-Enc 29" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 1 });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 1 });

    // Marca SKU como esgotado → encaminhar pro galpão SP
    await ctx.http.post("/api/wms/separacao/produto-esgotado", {
      sku,
      acao: "encaminhar",
      galpao_destino_id: ctx.staging.galpoes.sp.id,
    });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo CWB volta a 1 (estorno do pick S+L via resetarEstadoSeparacaoItens)
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 1);
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
