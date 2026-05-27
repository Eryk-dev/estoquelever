import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #7.13 — Cancelar venda manual em modo separacao (ainda não picada).
 *
 * Fluxo:
 *   1. Semear saldo CWB/A-01-09 = 10.
 *   2. Criar venda modo separacao com qty=4 → pedido em status='executando',
 *      status_separacao='aguardando_separacao'. (vendas/criar não cria R por
 *      si só.)
 *   3. Reservar R manualmente associada ao pedido_id (simula reserva criada
 *      por aprovação posterior). Saldo cai pra 6 disponivel, reservado=4.
 *   4. Cancelar venda → libera R (L), pedido vira 'cancelado'.
 *
 * assertEsperado:
 *   - Saldo final inalterado (R nunca virou S).
 *   - Reservado = 0 (todas R liberadas via L).
 *   - Pedido status='cancelado'.
 *   - reservasLiberadas >= 1 no retorno do endpoint.
 */
export default {
  nome: "45b — Cancelar venda separacao",
  descricao: "Venda em modo separacao c/ R injetada → cancelar libera R, pedido cancelado.",
  tags: ["vendas", "cancelar", "separacao", "reserva", "p3"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("45b");
    await ctx.criarProduto({ sku, descricao: "Cancelar venda separacao 45b" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-09", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Cria venda em modo separacao — pedido em aguardando_separacao,
    //    sem mov S (não decrementa saldo).
    const venda = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 4 }],
      modo: "separacao",
    });
    const pedidoId = (venda as unknown as { pedido_id?: string; id?: string }).pedido_id
      ?? venda.id;
    if (!pedidoId) throw new Error("venda criada sem id retornado");

    // Saldo ainda intacto (10), reservado=0
    await ctx.assertSaldo(sku, "CWB", "A-01-09", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-09", 0);

    // 2. Injeta R manual associada ao pedido_id (simula o que aprovar/iniciar
    //    fariam num fluxo real). RPC aceita pedido_id text — MAN-... cabe.
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-01-09")
      .single();
    const { error: rErr } = await ctx.sb.rpc("wms_reservar_atomico", {
      p_produto_id: prod!.id,
      p_galpao_id: ctx.staging.galpoes.cwb.id,
      p_localizacao_id: loc!.id,
      p_quantidade: 4,
      p_pedido_id: pedidoId,
      p_ttl_horas: 24,
    });
    if (rErr) throw new Error(`falha reservando R pra ${pedidoId}: ${rErr.message}`);

    // Reservado deve ter ido pra 4
    await ctx.assertReservado(sku, "CWB", "A-01-09", 4);

    // 3. Cancela — libera R
    const r = await ctx.cancelarVenda({
      pedido_id: pedidoId,
      motivo: "cenário 45b — cancelar antes de picar",
    });
    if (!r || typeof r.reservasLiberadas !== "number" || r.reservasLiberadas < 1) {
      throw new Error(
        `cancelarVenda deveria liberar ≥1 reserva; retornou ${JSON.stringify(r)}`,
      );
    }
    if (r.movsEstornadas !== 0) {
      throw new Error(
        `cancelarVenda em separacao não deveria estornar movs S; retornou ${JSON.stringify(r)}`,
      );
    }
    ctx.log(`cancelarVenda separacao OK — reservasLiberadas=${r.reservasLiberadas}`);

    (ctx as unknown as { _pedidoId45b?: string })._pedidoId45b = pedidoId;
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo intacto (R nunca virou S)
    await ctx.assertSaldo(sku, "CWB", "A-01-09", 10);

    // Reservado liberado
    await ctx.assertReservado(sku, "CWB", "A-01-09", 0);

    // Pedido cancelado
    const pedidoId = (ctx as unknown as { _pedidoId45b?: string })._pedidoId45b;
    if (!pedidoId) throw new Error("pedidoId não preservado entre run e assert");
    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("status")
      .eq("id", pedidoId)
      .single();
    const status = (pedido as { status?: string } | null)?.status;
    if (status !== "cancelado") {
      throw new Error(`pedido ${pedidoId} deveria estar status='cancelado'; got '${status}'`);
    }
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
