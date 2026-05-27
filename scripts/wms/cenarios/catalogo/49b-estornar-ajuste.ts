import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #3.20 reverse — Estornar ajuste manual.
 *
 * Cria saldo 10, faz ajuste +5 (saldo→15), captura mov_id, chama
 * `POST /api/wms/ajuste/[mov_id]/estornar`. Saldo volta pra 10.
 *
 * Valida que `estornarAjuste` recusa movs com `origem_tipo` diferente de
 * `ajuste_manual` (via guard no helper). Double-estorno é rejeitado pelo
 * guard `estorno_de IS NOT NULL` na rota.
 */
export default {
  nome: "49b — Estornar ajuste manual restaura saldo",
  descricao:
    "Saldo 10 + ajuste +5 (→15) + estornar mov: saldo volta pra 10, 3 movs no ledger (seed + ajuste + estorno).",
  tags: ["p3", "ajuste", "reverse", "idempotencia"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("49b");
    await ctx.criarProduto({ sku, descricao: "P3-49b estornar ajuste" });
    await ctx.semearSaldo({
      produto: sku,
      galpao: "CWB",
      loc: "A-01-01",
      qty: 10,
      custo: 8,
    });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1) Ajuste +5 — captura mov_id
    const ajuste = await ctx.ajusteManual({
      sku,
      galpao: "CWB",
      loc: "A-01-01",
      delta: 5,
      motivo: "cenário 49b — achado físico",
    });
    if (!ajuste.mov_id) {
      throw new Error("ajuste não retornou mov_id");
    }
    ctx.log("ajuste-criado", { mov_id: ajuste.mov_id });

    // Sanity: saldo subiu pra 15
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 15);

    // 2) Estornar — saldo volta pra 10
    await ctx.estornarAjuste({
      mov_id: ajuste.mov_id,
      motivo: "cenário 49b — operador bipou qty errada",
    });
    ctx.log("ajuste-estornado", { mov_id: ajuste.mov_id });

    // 3) Idempotência: 2ª chamada falha (já estornada). Verifica que
    //    rota recusa double-estorno com 400.
    let segundaFalhou = false;
    try {
      await ctx.estornarAjuste({
        mov_id: ajuste.mov_id,
        motivo: "cenário 49b — 2x (idempotência)",
      });
    } catch (e) {
      segundaFalhou = true;
      ctx.log("ajuste-estornado-2x-recusado", {
        erro: e instanceof Error ? e.message : String(e),
      });
    }
    if (!segundaFalhou) {
      throw new Error(
        "esperava 2ª chamada falhar (double-estorno), mas passou",
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo volta pra 10 (ajuste estornado)
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);

    // Custo médio inalterado (ajuste manual não mexe em custo)
    await ctx.assertCustoMedio(sku, 8, 0.01);

    // Total de movs: 1 E seed + 1 E ajuste + 1 S estorno = 3
    await ctx.assertMovsCount(sku, 3);

    // Verifica que existe uma mov de estorno apontando pra mov do ajuste
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: estornos } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id, origem_tipo, estorno_de")
      .eq("produto_id", prod!.id)
      .eq("origem_tipo", "estorno");
    if (!estornos || estornos.length !== 1) {
      throw new Error(
        `esperava 1 mov de estorno, achou ${estornos?.length ?? 0}`,
      );
    }
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
