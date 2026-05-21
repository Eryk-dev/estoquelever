import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "07 — Reservas TTL + cleanup",
  descricao: "Reservar com TTL=2s, esperar, cleanup gera L, disponível volta ao saldo total.",
  tags: ["reservas", "ttl", "cleanup", "concorrencia"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("07");
    await ctx.criarProduto({ sku, descricao: "Reserva 07" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-05", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    await ctx.reservar({ sku, galpao: "CWB", loc: "A-01-05", qty: 4, ttl_segundos: 2 });
    await ctx.assertReservado(sku, "CWB", "A-01-05", 4);

    // Tenta reservar acima do disponível (10 - 4 = 6 disponível, pede 7)
    let falhou = false;
    try { await ctx.reservar({ sku, galpao: "CWB", loc: "A-01-05", qty: 7, ttl_segundos: 2 }); }
    catch { falhou = true; }
    if (!falhou) throw new Error("reservar(7) deveria falhar (disponível=6)");

    await ctx.aguardar(3_000);
    await ctx.cleanupReservas();
    await ctx.assertReservado(sku, "CWB", "A-01-05", 0);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-05", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-05", 0);
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
