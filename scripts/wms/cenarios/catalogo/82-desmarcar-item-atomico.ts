import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 82c — desmarcar item via RPC atômica (D4)
 *
 * Aprova um pedido próprio (R criada no auto-aprove), marca o item via
 * /api/wms/separacao/marcar-item {marcado:true} (emite L+S pareados), depois
 * desmarca {marcado:false}. A rota agora chama wms_desmarcar_item_atomico:
 * estorno S+L na MESMA tx. Assert que o item desmarcou (separacao_marcado=false,
 * mov_saida_id limpo) e que a R ressuscitou (existe R viva pós-desmarca).
 */

type Setup = {
  sku: string;
  // Populados durante run (assertEsperado recebe só ctx + setup)
  pedidoId: string;
  itemId: number;
};

export default {
  nome: "82c — desmarcar item via RPC atômica tolerante [D4] (marcado:false)",
  descricao:
    "Pedido próprio aprovado (R viva). marcar-item {marcado:true} emite L+S; " +
    "{marcado:false} chama wms_desmarcar_item_atomico (estorno S+L atômico). " +
    "Item desmarca + R ressuscita.",
  tags: ["separacao", "marcar-item", "desmarcar", "atomico", "d4"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("82c");
    await ctx.criarProduto({ sku, descricao: "Desmarcar Atomico 82c" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10 });
    return { sku, pedidoId: "", itemId: 0 };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;

    // ── 1. Webhook: pedido de 3 unidades com saldo → auto-aprova como propria ──
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    setup.pedidoId = pedido.id;
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");

    // R viva: saldo 10, reservado 3
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    await ctx.iniciarSeparacao(pedido.id);

    // ── 2. Carrega o item ──
    const { data: itens } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, sku")
      .eq("pedido_id", pedido.id);
    const itemId = (itens as Array<{ id: number; sku: string }> | null)?.find(
      (it) => it.sku === sku,
    )?.id;
    if (!itemId) throw new Error("pedido_item não encontrado");
    setup.itemId = itemId;

    // ── 3. Marca checkbox → L+S. Saldo 10→7, reservado 3→0. ──
    await ctx.http.post("/api/wms/separacao/marcar-item", {
      pedido_item_id: itemId,
      marcado: true,
    });
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 7);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);

    // ── 4. Desmarca → wms_desmarcar_item_atomico estorna S+L atômico. ──
    await ctx.http.post("/api/wms/separacao/marcar-item", {
      pedido_item_id: itemId,
      marcado: false,
    });
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb.from("siso_pedido_itens")
      .select("separacao_marcado, quantidade_pega, mov_saida_id")
      .eq("id", setup.itemId).single();
    if ((item as any).separacao_marcado !== false) throw new Error("item não desmarcou");
    if ((item as any).mov_saida_id !== null) throw new Error("mov_saida_id não limpou");
    // reservado voltou: existe R viva pós-desmarca
    const { data: rs } = await ctx.sb.from("siso_movimentacoes")
      .select("id").eq("origem_id", setup.pedidoId).eq("tipo", "R").eq("origem_tipo", "reserva_pedido");
    if (!rs || rs.length === 0) throw new Error("R não ressuscitou após desmarca");
  },
} satisfies Cenario<Setup>;

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
