import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "18 — Aprovar cria reserva (saldo chegou depois)",
  descricao:
    "Webhook entra sem saldo (sugestao=oc), operador adiciona saldo via " +
    "ajuste, aprova manualmente como propria — aprovar deve criar R no " +
    "ledger antes de transitar status.",
  tags: ["pedido", "aprovar", "reserva", "wms-as-source"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("18");
    await ctx.criarProduto({ sku, descricao: "Aprovar reserva 18" });
    // NÃO semeia saldo — webhook vai pra OC
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Webhook entra sem saldo → sugestao=oc
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: undefined }, { timeout_ms: 8_000 });

    // 2. Adiciona saldo agora (depois do webhook)
    await ctx.ajusteManual({
      sku,
      galpao: "CWB",
      loc: "DEFAULT-PICKING",
      delta: 10,
      motivo: "Setup pós-webhook pra testar aprovar com reserva",
    });

    // 3. Operador aprova como propria (agora tem saldo)
    await ctx.aprovar(pedido.id, "propria");
    await ctx.aguardarStatus(pedido.id, "executando");
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo continua 10 (reserva não baixa saldo, só reservado)
    await ctx.assertSaldo(sku, "CWB", "DEFAULT-PICKING", 10);
    // Reservado = 3 (a reserva foi criada)
    await ctx.assertReservado(sku, "CWB", "DEFAULT-PICKING", 3);
    // 2 movs: 1 E (ajuste) + 1 R (reserva criada pelo aprovar)
    await ctx.assertMovsCount(sku, 2);
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
