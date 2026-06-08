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
    // Pós F1 (auto-OC): OC é auto-aprovada pelo webhook, não precisa mais
    // de aprovação manual. Aguarda diretamente validacao_oc setada pelo worker.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // ctx.comprar com pedido_id chama validar-oc-item (acao=esgotado) primeiro,
    // transicionando o pedido pra aguardando_compra, e depois /compras/comprar
    // marca os itens como `comprado` (não dispara release ainda).
    await ctx.comprar({ sku, qty: 3, pedido_id: pedido.id });

    // /compras/receber marca itens recebido → dispara compras-release →
    // aguardando_nf. Worker imediatamente gera NF e o aguardarStatusSeparacao
    // simula o webhook NF, transitando direto pra aguardando_separacao.
    // Pulamos a espera intermediária e vamos direto pra aguardando_separacao.
    await ctx.receberCompra({ ordem_id: "ignored", items: [{ sku, qty: 3 }] });

    // Recebimento físico no dock — entrada_direta grava 1 mov 'E' direto
    // na loc destino e pula a pendência de guarda. Roda em paralelo com
    // a transição via worker (não bloqueia).
    await ctx.receber({
      galpao: "CWB",
      entrada_direta: true,
      items: [{ sku, qty: 3, loc_destino: "A-01-01" }],
    });

    // Fix-Final A T20 (#A4): patch SQL removido — marcar-item resolve via
    // buscarLocComMaiorSaldoNoGalpao quando snapshot está vazio, com
    // fallback final pra DEFAULT-PICKING (existe em CWB seed P6).

    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao", { timeout_ms: 8_000 });

    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    // 1 E (entrada_direta) + 1 S (picking) = 2 movs. Saldo final = 0.
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    await ctx.assertMovsCount(sku, 2);
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
