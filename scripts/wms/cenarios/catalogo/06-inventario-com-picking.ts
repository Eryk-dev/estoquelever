import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "06 — Inventário com picking concorrente",
  descricao: "Sessão inventário em A-01-04; pedido bipa antes do inventário contar; reconciliação temporal zera divergência falsa.",
  tags: ["inventario", "concorrencia", "reconciliacao_temporal"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("06");
    await ctx.criarProduto({ sku, descricao: "Conc 06" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-04", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Cria sessão de inventário em A-01-04
    const sess = await ctx.criarSessaoInventario({ galpao: "CWB", locs: ["A-01-04"], modo: "blind", tipo: "cycle_count" });
    await ctx.entrarParty(sess.id);
    // Reivindica a loc via pull queue — sem isso a loc não fica bloqueada
    // pelo operador e o finalizar dá 400 ("apenas o operador que bloqueou…").
    await ctx.proximaLoc(sess.id);

    // 2. Pedido bipa 3 unidades — acontece DEPOIS de criar a sessão mas ANTES de o operador contar
    const pedido = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 3 }] });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao", { timeout_ms: 8_000 });
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);

    // 3. Operador conta: vê 7 (10 - 3 já saiu)
    await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-04", qty: 7 });
    await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-04" });

    // 4. Aprova — reconciliação temporal deve ver que saldo no bipe era 7, contado 7, delta = 0
    await ctx.aprovarInventario(sess.id);
    await ctx.aplicarInventario(sess.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 7);
    // Sem mov de ajuste de inventário, pois delta foi 0
    const { count } = await ctx.sb.from("siso_movimentacoes").select("id", { count: "exact", head: true }).eq("origem_tipo", "inventario_perda");
    if ((count ?? 0) > 0) throw new Error(`assertEsperado: esperava 0 movs de inventario_perda, achou ${count}`);
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
