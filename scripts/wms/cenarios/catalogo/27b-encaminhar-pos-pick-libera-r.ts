import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "27b — encaminhar pós-pick parcial libera R restantes",
  descricao:
    "Pedido com 2 itens, op bipa apenas o primeiro, depois encaminha. " +
    "R do item bipado vira L+S; R do item não-bipado deve ser liberada " +
    "no encaminhar (per-R fix, #2.9 follow-up).",
  tags: ["separacao", "encaminhar", "reserva", "pos-pick"],

  setup: async (ctx: Ctx) => {
    const skuA = ctx.skuUnico("27bA");
    const skuB = ctx.skuUnico("27bB");
    await ctx.criarProduto({ sku: skuA, descricao: "Encaminhar 27b A" });
    await ctx.criarProduto({ sku: skuB, descricao: "Encaminhar 27b B" });
    await ctx.semearSaldo({ produto: skuA, galpao: "CWB", loc: "A-01-01", qty: 5 });
    await ctx.semearSaldo({ produto: skuB, galpao: "CWB", loc: "A-01-02", qty: 5 });
    return { skuA, skuB };
  },

  run: async (ctx, { skuA, skuB }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }],
    });
    // Webhook com 2 itens leva ~8s no stub Tiny; bumpa timeouts pra evitar flake.
    await ctx.aguardarStatus(pedido.id, "concluido", undefined, { timeout_ms: 15_000 });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao", { timeout_ms: 15_000 });
    await ctx.iniciarSeparacao(pedido.id);

    // Bipa apenas o item A (gera L+S — convertendo R do A).
    // Como `bipar` aqui é marcar-item (item inteiro), qty=1 cobre a qty_pedida.
    await ctx.bipar({ pedido: pedido.id, item: skuA, qty: 1 });

    // Encaminha → deve liberar R do B (que ainda existe).
    await ctx.http.post("/api/wms/separacao/encaminhar", {
      pedido_ids: [pedido.id],
      galpao_destino_id: ctx.staging.galpoes.sp.id,
    });
  },

  assertEsperado: async (ctx, { skuA, skuB }) => {
    // Pós-encaminhar: reset-state estorna S do bipe do A (saldo volta de 4 → 5)
    // e per-R fix libera R do B (reservado volta a 0). Sem o fix, R do B
    // ficaria zumbi (liberarReserva por pedido tinha short-circuit por causa
    // do L do A).
    await ctx.assertSaldo(skuA, "CWB", "A-01-01", 5);
    await ctx.assertReservado(skuA, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(skuB, "CWB", "A-01-02", 5);
    await ctx.assertReservado(skuB, "CWB", "A-01-02", 0);
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ skuA: string; skuB: string }>;

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
