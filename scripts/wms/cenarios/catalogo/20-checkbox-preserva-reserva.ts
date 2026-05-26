import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "20 — Checkbox marcar/desmarcar mantém reservado coerente",
  descricao:
    "Após aprovar (R criada), o checkbox de marcar-item emite L+S pareados: " +
    "marcar zera reservado, desmarcar recria R, marcar de novo zera de novo. " +
    "Sem leak de reservado órfão. Concluir vê R já convertida e vira no-op.",
  tags: ["separacao", "marcar-item", "reserva", "wms-as-source"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("20");
    await ctx.criarProduto({ sku, descricao: "Checkbox-R 20" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    // Auto-aprova como propria; status final = concluido (worker enfileira mas
    // o pedido continua aberto pro picking via status_separacao).
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");

    // R deve estar viva: saldo 10, reservado 3
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    await ctx.iniciarSeparacao(pedido.id);

    // Carrega pedido_item_id do item
    const { data: itens } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, sku")
      .eq("pedido_id", pedido.id);
    const itemId = (itens as Array<{ id: number; sku: string }> | null)?.find(
      (it) => it.sku === sku,
    )?.id;
    if (!itemId) throw new Error("pedido_item não encontrado");

    // 1. Marca checkbox → L+S. Saldo 10→7, reservado 3→0.
    await ctx.http.post("/api/wms/separacao/marcar-item", {
      pedido_item_id: itemId,
      marcado: true,
    });
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 7);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);

    // 2. Desmarca → estorna S (E counter, saldo volta) + estorna L (R nova).
    await ctx.http.post("/api/wms/separacao/marcar-item", {
      pedido_item_id: itemId,
      marcado: false,
    });
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    // 3. Marca de novo → L+S novos sobre a R recriada.
    await ctx.http.post("/api/wms/separacao/marcar-item", {
      pedido_item_id: itemId,
      marcado: true,
    });
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 7);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);

    // Concluir vê todas as R já com L → no-op no cutover.
    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado");
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 7);
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
