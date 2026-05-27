import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 27 — wms_inventario_sugerir exclui locs tipo=quarentena
 *
 * Cria uma loc tipo=quarentena no galpão CWB, semeia saldo via ajuste manual
 * pra dar volume à loc, e chama `wms_inventario_sugerir(p_galpao, p_tamanho=50)`.
 * A loc quarentena NÃO pode aparecer no resultado (locs retidas não devem ir
 * pra cycle count).
 */
export default {
  nome: "27 — wms_inventario_sugerir exclui locs tipo=quarentena",
  descricao:
    "Loc tipo=quarentena com saldo > 0 não pode ser sugerida pra cycle count.",
  tags: ["inventario", "sugerir", "quarentena", "p6"],

  setup: async (ctx: Ctx) => {
    const galpaoCwbId = ctx.staging.galpoes.cwb.id;
    const sku = ctx.skuUnico("27");
    const locCodigo = `QUARENTENA-TEST-27-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    await ctx.criarProduto({ sku, descricao: "Sugerir exclui quarentena 27" });
    const locQuarentenaId = await ctx.criarLocalizacao({
      galpao: "CWB",
      codigo: locCodigo,
      tipo: "quarentena",
    });

    // Semeia saldo via ajuste manual (entrada) — dá volume na quarentena pra
    // que ela seja candidata "natural" às 3 CTEs da RPC.
    await ctx.ajusteManual({
      sku,
      galpao: "CWB",
      loc: locCodigo,
      delta: 5,
      motivo: "seed cenário 27 (quarentena)",
    });

    return { sku, locQuarentenaId, locCodigo, galpaoCwbId };
  },

  run: async (ctx, { locQuarentenaId, galpaoCwbId }) => {
    const { data, error } = await ctx.sb.rpc("wms_inventario_sugerir", {
      p_galpao: galpaoCwbId,
      p_tamanho: 50,
    });
    if (error) {
      throw new Error(`wms_inventario_sugerir falhou: ${error.message}`);
    }
    const sugestoes = (data ?? []) as Array<{ localizacao_id: string }>;
    const found = sugestoes.some((s) => s.localizacao_id === locQuarentenaId);
    if (found) {
      throw new Error(
        `loc quarentena (${locQuarentenaId}) não pode aparecer na sugestão`,
      );
    }
  },

  assertEsperado: async (ctx, { sku, locCodigo }) => {
    // Saldo continua intacto na loc quarentena (a RPC é read-only).
    await ctx.assertSaldo(sku, "CWB", locCodigo, 5);
  },
} satisfies Cenario<{
  sku: string;
  locQuarentenaId: string;
  locCodigo: string;
  galpaoCwbId: string;
}>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
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
