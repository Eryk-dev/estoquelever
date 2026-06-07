import type { Cenario, Ctx } from "../_harness/types";

type Setup = { sku: string; loc: string; sessaoId: string };

export default {
  nome: "83 — [P059] compra entre contagem e cutoff não gera divergência falsa",
  descricao:
    "Mov E (compra via ajuste +5) chega APÓS o bipe da contagem mas ANTES do /aprovar (cutoff). A janela ampliada (início do dia) captura a mov; reconciliarTemporal vê saldo_anterior=3=contado → delta 0 → zero divergência.",
  tags: ["inventario", "reconciliacao", "reconciliacao_temporal", "P059"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("83");
    await ctx.criarProduto({ sku, descricao: "Reconc 83" });
    const loc = "INV83-01";
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: loc, tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc, qty: 3 });
    const sess = await ctx.criarSessaoInventario({ galpao: "CWB", locs: [loc], modo: "blind", tipo: "cycle_count" });
    return { sku, loc, sessaoId: sess.id };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    await ctx.entrarParty(setup.sessaoId);
    // Reivindica a loc via pull queue (sem isso o finalizar dá 400).
    await ctx.proximaLoc(setup.sessaoId);
    // Operador conta 3 (= saldo real no momento do bipe).
    await ctx.bipeInventario({ sessao_id: setup.sessaoId, sku: setup.sku, loc: setup.loc, qty: 3 });
    await ctx.finalizarLocInventario({ sessao_id: setup.sessaoId, loc: setup.loc });
    // Compra chega DEPOIS da contagem, ANTES do /aprovar (cutoff): saldo 3 → 8.
    await ctx.ajusteManual({ sku: setup.sku, galpao: "CWB", loc: setup.loc, delta: 5, motivo: "compra pós-contagem", motivo_categoria: "achado" });
    // /aprovar computa as divergências (define o cutoff).
    await ctx.aprovarInventario(setup.sessaoId);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", setup.sku).single();
    const produtoId = (prod as { id: string }).id;
    const { data: divs } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("id, saldo_sistema, qty_contada_final, status")
      .eq("sessao_id", setup.sessaoId)
      .eq("produto_id", produtoId);
    const linhas = (divs ?? []) as Array<{ id: string; saldo_sistema: number; qty_contada_final: number; status: string }>;
    if (linhas.length > 0) {
      throw new Error(
        `divergência fantasma: ${JSON.stringify(linhas)} — a janela não capturou a compra pós-contagem (esperava 0 divergências)`,
      );
    }
  },
} satisfies Cenario<Setup>;

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
