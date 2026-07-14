import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "93 — Inventário libera reserva quando a peça não existe",
  descricao:
    "Saldo 1 totalmente reservado; inventário conta 0. Aplicar deve liberar a R, " +
    "aplicar a perda e enviar o pedido para realocação na mesma transação.",
  tags: ["inventario", "reserva", "regressao", "sp"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("93");
    const loc = `TEST-INV-${sku.slice(-6)}`;
    await ctx.criarProduto({ sku, descricao: "Inventário vence reserva 93" });
    await ctx.criarLocalizacao({ galpao: "SP", codigo: loc, tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc, qty: 1 });
    return { sku, loc };
  },

  run: async (ctx, state) => {
    const { sku, loc } = state;
    const venda = await ctx.criarVendaDireta({
      galpao: "SP",
      empresa: "netparts",
      items: [{ sku, qty: 1 }],
      modo: "separacao",
    });
    const pedidoId = venda.pedido_id;
    if (!pedidoId) throw new Error("venda modo separação não retornou pedido_id");

    await ctx.assertSaldo(sku, "SP", loc, 1);
    await ctx.assertReservado(sku, "SP", loc, 1);

    const sessao = await ctx.criarSessaoInventario({
      galpao: "SP",
      locs: [loc],
      modo: "blind",
      tipo: "cycle_count",
    });
    await ctx.entrarParty(sessao.id);
    await ctx.proximaLoc(sessao.id);
    await ctx.bipeInventario({
      sessao_id: sessao.id,
      sku,
      loc,
      qty: 0,
    });
    await ctx.finalizarLocInventario({ sessao_id: sessao.id, loc });

    // Aprovação automática da divergência de -1; o foco do cenário é aplicar.
    await ctx.sb
      .from("siso_inventario_sessoes")
      .update({ tolerancia_pct: 999 })
      .eq("id", sessao.id);
    await ctx.aprovarInventario(sessao.id);
    await ctx.aplicarInventario(sessao.id);

    state.pedidoId = pedidoId;
    state.sessaoId = sessao.id;
  },

  assertEsperado: async (ctx, { sku, loc, pedidoId, sessaoId }) => {
    if (!pedidoId || !sessaoId) throw new Error("estado do cenário incompleto");
    await ctx.assertSaldo(sku, "SP", loc, 0);
    await ctx.assertReservado(sku, "SP", loc, 0);

    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("status_separacao")
      .eq("id", pedidoId)
      .single();
    if (pedido?.status_separacao !== "pendente_realocacao") {
      throw new Error(
        `pedido deveria ir para pendente_realocacao; atual=${pedido?.status_separacao}`,
      );
    }

    const { data: liberacoes } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id, quantidade, origem_detalhes")
      .eq("tipo", "L")
      .eq("origem_tipo", "liberacao_reserva")
      .eq("origem_id", pedidoId)
      .contains("origem_detalhes", { contexto: "inventario_fonte_verdade" });
    if ((liberacoes ?? []).length !== 1) {
      throw new Error(`esperava 1 liberação automática; achou ${liberacoes?.length ?? 0}`);
    }

    const { count: perdas } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("origem_tipo", "inventario_perda")
      .eq("origem_id", sessaoId);
    if (perdas !== 1) throw new Error(`esperava 1 perda de inventário; achou ${perdas}`);

    await ctx.cancelarVenda({
      pedido_id: pedidoId,
      motivo: "limpeza do cenário 93 após as asserções",
    });
  },
} satisfies Cenario<{
  sku: string;
  loc: string;
  pedidoId?: string;
  sessaoId?: string;
}>;

import { runStandalone } from "../_harness/standalone";

const _isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
