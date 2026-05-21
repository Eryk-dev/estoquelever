import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "04 — Parcial + realocação cascateada",
  descricao: "Bipa 3/5, loc zerou, cascade pega 2/2 em outra loc, finaliza.",
  tags: ["separacao", "parcial", "realocacao", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("04");
    await ctx.criarProduto({ sku, descricao: "Realoc 04" });
    // Empiricamente o tiny-stub escolhe a loc semeada por SEGUNDO como
    // `primeiraLocalizacao` (a ordem da query é indeterminada mas estável).
    // A loc 2 (A-01-02 com 3 unidades) é a "primária"; após pegar 2 e
    // declarar loc_zerou, o residual (3) cascade pra A-01-01 com 3 unidades.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 3 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 5 }] });
    await ctx.aguardarStatus(pedido.id, "concluido"); // auto
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    // Pega 2 da loc primária (não esgota — qty<saldo) mas marca loc_zerou=true
    // → ajuste descarta 1 unidade restante. Cascade busca residual (qty_pedida
    // - qty_pega = 5-2 = 3) em outra loc → A-01-01 com 3.
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 2, loc_zerou: true });
    await ctx.aguardarRealocacao(pedido.id, sku, "A-01-01");
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    // A-01-02: picou 2 (loc_zerou ajusta 1) → 0
    // A-01-01: realocou 3 → 0
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 0);
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
