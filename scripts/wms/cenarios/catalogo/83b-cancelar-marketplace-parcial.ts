import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 83b — D1 marketplace: /separacao/cancelar com cancelar_pedido=true (P007).
 * Pedido marketplace em em_separacao, item1 pego (mov S) e item2 não-pego.
 *  - item2 reserva liberada; item1 S preservada; pedido cancelado; item1 em devolução manual.
 */
type Setup = { skuA: string; skuB: string; pedidoId: string };

export default {
  nome: "83b-cancelar-marketplace — D1 marketplace: /separacao/cancelar cancelar_pedido (P007)",
  descricao: "marketplace em_separacao parcial → libera só não-pego via /separacao/cancelar.",
  tags: ["cancelamento", "separacao", "parcial", "marketplace", "D1", "P007"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("83ba");
    const skuB = ctx.skuUnico("83bb");
    await ctx.criarProduto({ sku: skuA, descricao: "MP parcial A" });
    await ctx.criarProduto({ sku: skuB, descricao: "MP parcial B" });
    await ctx.semearSaldo({ produto: skuA, galpao: "CWB", loc: "A-01-02", qty: 5 });
    await ctx.semearSaldo({ produto: skuB, galpao: "CWB", loc: "A-01-03", qty: 5 });
    return { skuA, skuB, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB } = setup;
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }],
    });
    setup.pedidoId = id;
    // propria → auto-aprova → concluido + aguardando_separacao (itens já gravados c/ sku)
    await ctx.aguardarStatus(id, "concluido", undefined, { timeout_ms: 20000 });
    await ctx.aguardarStatusSeparacao(id, "aguardando_separacao", { timeout_ms: 20000 });
    await ctx.sb.from("siso_pedidos").update({ status_separacao: "em_separacao" }).eq("id", id);

    const { data: itens } = await ctx.sb.from("siso_pedido_itens").select("id, sku").eq("pedido_id", id);
    const itemA = (itens ?? []).find((i) => (i as { sku: string }).sku === skuA) as { id: string };
    if (!itemA) throw new Error(`83b: item ${skuA} não encontrado em ${JSON.stringify(itens)}`);
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
      p_origem_id: id,
      p_custo_unitario: null,
      p_motivo: "pick item A (cenário 83b)",
    });
    await ctx.sb.from("siso_pedido_itens").update({ mov_saida_id: String(movS as unknown as string), quantidade_pega: 1 }).eq("id", itemA.id);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { skuA, skuB, pedidoId } = setup;
    const resp = await ctx.http.post<{ itens_para_devolver_manual?: Array<{ id: string; sku: string }> }>(
      "/api/wms/separacao/cancelar",
      { pedido_ids: [pedidoId], cancelar_pedido: true },
    );
    await ctx.assertReservado(skuB, "CWB", "A-01-03", 0);
    await ctx.assertSaldo(skuA, "CWB", "A-01-02", 4);
    const lista = resp.itens_para_devolver_manual ?? [];
    if (!lista.some((i) => i.sku === skuA)) {
      throw new Error(`P007 mp: esperava ${skuA} em itens_para_devolver_manual`);
    }
    const { data: pedido } = await ctx.sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P007 mp: status esperado 'cancelado', got '${(pedido as { status: string }).status}'`);
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
