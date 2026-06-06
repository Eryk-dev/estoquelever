import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83 — D1: cancelar venda manual em em_separacao parcial (P007).
 * item1 já picado (mov_saida_id != null), item2 sem pick. POST cancelar:
 *  - reserva R do item2 liberada; item1 NÃO estornado (S permanece);
 *  - response lista item1 como pendente_devolucao_manual; pedido cancelado.
 * RED hoje: endpoint retorna 400 bloqueando tudo.
 */
type Setup = { skuA: string; skuB: string; pedidoId: string };

export default {
  nome: "83-cancelar-pedido — D1: cancelar venda manual em separação parcial (P007)",
  descricao: "em_separacao com 1 item pego e 1 não-pego → libera só não-pego, pego vira devolução manual.",
  tags: ["cancelamento", "separacao", "parcial", "venda-manual", "D1", "P007"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("83a");
    const skuB = ctx.skuUnico("83b");
    await ctx.criarProduto({ sku: skuA, descricao: "Parcial cancel A" });
    await ctx.criarProduto({ sku: skuB, descricao: "Parcial cancel B" });
    await ctx.semearSaldo({ produto: skuA, galpao: "CWB", loc: "A-01-02", qty: 5 });
    await ctx.semearSaldo({ produto: skuB, galpao: "CWB", loc: "A-01-03", qty: 5 });
    return { skuA, skuB, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB } = setup;
    const venda = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }],
      modo: "separacao",
    });
    const pedidoId = String(venda.pedido_id ?? venda.id);
    setup.pedidoId = pedidoId;

    const { data: itens } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, sku")
      .eq("pedido_id", pedidoId);
    const itemA = (itens ?? []).find((i) => (i as { sku: string }).sku === skuA) as { id: string };

    await ctx.sb.from("siso_pedidos").update({ status_separacao: "em_separacao" }).eq("id", pedidoId);
    const { data: gA } = await ctx.sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: lA } = await ctx.sb.from("siso_localizacoes").select("id").eq("galpao_id", (gA as { id: string }).id).eq("codigo", "A-01-02").single();
    const { data: pA } = await ctx.sb.from("siso_produtos").select("id").eq("sku", skuA).single();
    const { data: movS } = await ctx.sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: (pA as { id: string }).id,
      p_galpao_id: (gA as { id: string }).id,
      p_localizacao_id: (lA as { id: string }).id,
      p_tipo: "S",
      p_quantidade: 1,
      p_origem_tipo: "venda_manual",
      p_origem_id: pedidoId,
      p_custo_unitario: null,
      p_motivo: "pick item A (cenário 83)",
    });
    await ctx.sb.from("siso_pedido_itens").update({ mov_saida_id: String(movS as unknown as string), quantidade_pega: 1 }).eq("id", itemA.id);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB, pedidoId } = setup;
    const resp = await ctx.http.post<{ itens_para_devolver_manual?: Array<{ id: string; sku: string }> }>(
      `/api/wms/vendas/${pedidoId}/cancelar`,
      { motivo: "cancelamento em separação parcial" },
    );
    await ctx.assertReservado(skuB, "CWB", "A-01-03", 0);
    await ctx.assertSaldo(skuA, "CWB", "A-01-02", 4);
    const lista = resp.itens_para_devolver_manual ?? [];
    if (!lista.some((i) => i.sku === skuA)) {
      throw new Error(`P007: esperava ${skuA} em itens_para_devolver_manual, got ${JSON.stringify(lista)}`);
    }
    const { data: pedido } = await ctx.sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P007: status esperado 'cancelado', got '${(pedido as { status: string }).status}'`);
    }
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
