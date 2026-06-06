// scripts/wms/cenarios/catalogo/34-recusar-pedido-libera-r.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 34 — Recusar pedido (decisao=rejeitado) libera a reserva R (P034).
 *
 * Pedido transferencia em 'pendente' com R viva. Operador recusa.
 * Espera: status='cancelado' E reservado volta a 0 imediatamente (R estornada).
 * RED hoje: rejeitado marca cancelado mas deixa R presa até TTL (30d).
 */
type Setup = { sku: string; pedidoId: string };

export default {
  nome: "34-recusar — Recusar pedido libera reserva R imediatamente (P034)",
  descricao:
    "Pedido com R viva, decisao=rejeitado → status cancelado + reservado=0 (sem esperar TTL).",
  tags: ["cancelamento", "reserva", "recusar", "P034"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("34r");
    await ctx.criarProduto({ sku, descricao: "Recusar libera R 34" });
    // Saldo só em SP → pedido da NetAir (casa CWB) cai em transferencia, que reserva.
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-01", qty: 5 });
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    setup.pedidoId = id;
    // transferencia → fica pendente com R viva.
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });
    // sanity: reservado=2 em SP
    await ctx.assertReservado(sku, "SP", "C-01-01", 2);

    // Recusa.
    await ctx.http.post("/api/wms/pedidos/aprovar", { pedidoId: id, decisao: "rejeitado", motivo: "teste recusa" });
    await ctx.aguardar(1500);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, pedidoId } = setup;
    const { data: pedido } = await ctx.sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P034: status esperado 'cancelado', got '${(pedido as { status: string }).status}'`);
    }
    // R liberada → reservado volta a 0.
    await ctx.assertReservado(sku, "SP", "C-01-01", 0);
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
