import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #8.8 reverse — Reverter replenishment intra-galpão.
 *
 * Cria saldo em A-01-01, move 5 unidades pra A-01-02 via replenishment
 * (par S+E mesmo origem_id), captura `origem_id` da resposta. Chama
 * `/api/wms/replenishment/[origem_id]/reverter`: estorna ambas as legs do
 * par. Saldo volta pra A-01-01, A-01-02 zera.
 *
 * Idempotência: 2ª chamada não estorna nada (todas as movs já estornadas)
 * — retorna `movsEstornadas: 0` (sem 400, pq idempotente por design no helper).
 */
export default {
  nome: "48 — Reverter replenishment estorna par S+E completo",
  descricao:
    "Replenishment de 5 unid A-01-01 → A-01-02, depois reverter: saldo volta pra A-01-01 (10), A-01-02 zera, movsEstornadas=2.",
  tags: ["p3", "replenishment", "reverse", "idempotencia"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("48");
    await ctx.criarProduto({ sku, descricao: "P3-48 reverter replenishment" });
    await ctx.semearSaldo({
      produto: sku,
      galpao: "CWB",
      loc: "A-01-01",
      qty: 10,
      custo: 12,
    });
    // Garante loc destino existe
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-01-02", tipo: "picking" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1) Replenishment 5 unid A-01-01 → A-01-02 (captura origem_id)
    const repl = await ctx.replenishment({
      sku,
      galpao: "CWB",
      origem_loc: "A-01-01",
      destino_loc: "A-01-02",
      qty: 5,
    });
    if (!repl.origem_id) {
      throw new Error("replenishment não retornou origem_id");
    }
    ctx.log("replenishment", { origem_id: repl.origem_id, mov_ids: repl.mov_ids });

    // Sanity pré-reverter: saldo origem caiu pra 5, destino subiu pra 5
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 5);
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 5);

    // 2) Reverter — estorna par S+E
    const r = await ctx.reverterReplenishment({
      origem_id: repl.origem_id,
      motivo: "cenário 48 — reverter replenishment",
    });
    ctx.log("reverter-replenishment", { ...r });
    if (r.movsEstornadas !== 2) {
      throw new Error(
        `esperava 2 movs estornadas (par S+E), achou ${r.movsEstornadas}`,
      );
    }

    // 3) Idempotência: 2ª chamada não estorna mais nada
    const r2 = await ctx.reverterReplenishment({
      origem_id: repl.origem_id,
      motivo: "cenário 48 — 2x (idempotência)",
    });
    if (r2.movsEstornadas !== 0) {
      throw new Error(
        `esperava 0 movs estornadas na 2ª chamada (idempotência), achou ${r2.movsEstornadas}`,
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo origem A-01-01 volta pra 10 (S estornado)
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    // Saldo destino A-01-02 volta pra 0 (E estornado)
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 0);

    // Custo médio inalterado (replenishment é neutro)
    await ctx.assertCustoMedio(sku, 12, 0.01);

    // Total de movs do produto:
    //   1 E seed +
    //   1 S + 1 E (replenishment) +
    //   1 E + 1 S (estornos das duas legs) = 5
    await ctx.assertMovsCount(sku, 5);
  },
} satisfies Cenario<{ sku: string }>;

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
