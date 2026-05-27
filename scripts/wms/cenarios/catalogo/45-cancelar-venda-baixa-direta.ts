import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #7.13 — Cancelar venda manual em modo baixa_direta.
 *
 * Fluxo:
 *   1. Semear saldo CWB/A-01-10 = 8.
 *   2. Criar venda modo baixa_direta com qty=3 → mov S, saldo cai pra 5.
 *   3. Cancelar venda → estorna mov S, saldo volta pra 8.
 *
 * assertEsperado:
 *   - Saldo CWB/A-01-10 = 8 (recuperado).
 *   - Pedido status='cancelado'.
 *   - Pelo menos 1 mov estornada (retorno do endpoint).
 */
export default {
  nome: "45 — Cancelar venda baixa_direta",
  descricao: "Venda baixa_direta executada → cancelar estorna mov S e devolve saldo.",
  tags: ["vendas", "cancelar", "baixa_direta", "estorno", "p3"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("45");
    await ctx.criarProduto({ sku, descricao: "Cancelar venda baixa 45" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-10", qty: 8 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Cria venda em baixa_direta — saldo cai pra 5
    const venda = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 3 }],
      modo: "baixa_direta",
    });
    if (venda.degradado) {
      throw new Error(
        `venda inesperadamente degradada: ${venda.motivo_degradacao} skus=${JSON.stringify(venda.skus_sem_saldo)}`,
      );
    }
    // pedido_id é retornado em `id` ou `pedido_id` dependendo da forma.
    // criarVendaDireta tipa como { id }, mas resposta real usa `pedido_id`.
    const pedidoId = (venda as unknown as { pedido_id?: string; id?: string }).pedido_id
      ?? venda.id;
    if (!pedidoId) throw new Error("venda criada sem id retornado");

    await ctx.assertSaldo(sku, "CWB", "A-01-10", 5);

    // 2. Cancela venda — estorna mov, saldo volta pra 8
    const r = await ctx.cancelarVenda({
      pedido_id: pedidoId,
      motivo: "cenário 45 — operador errou venda, undo",
    });
    if (!r || typeof r.movsEstornadas !== "number" || r.movsEstornadas < 1) {
      throw new Error(
        `cancelarVenda deveria estornar ≥1 mov; retornou ${JSON.stringify(r)}`,
      );
    }
    ctx.log(`cancelarVenda OK — movsEstornadas=${r.movsEstornadas}`);

    // Guarda pedidoId pra assertEsperado
    (ctx as unknown as { _pedidoId45?: string })._pedidoId45 = pedidoId;
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo recuperado (estorno reverteu mov S)
    await ctx.assertSaldo(sku, "CWB", "A-01-10", 8);

    // Pedido cancelado — checa coluna status diretamente
    const pedidoId = (ctx as unknown as { _pedidoId45?: string })._pedidoId45;
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
