import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "33 — Aplicar inventário com divergência positiva propaga custo médio",
  descricao:
    "Cenário inicial: saldo 0 sem custo médio. Ajusta +10 (saldo=10) e " +
    "injeta custo médio 5.0 direto via UPSERT (ajuste manual não passa " +
    "custo_unitario). Inventário acha 12 (+2 ganho). Aplicar deve passar " +
    "custo_unitario=5.0 (último entrante) pra que o ganho não dilua o " +
    "custo médio.",
  tags: ["inventario", "custo-medio", "ledger"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("33");
    await ctx.criarProduto({ sku, descricao: "Inv-Custo 33" });
    await ctx.ajusteManual({
      sku, galpao: "CWB", loc: "A-01-01", delta: 10,
      motivo: "Setup custo 33",
    });
    // Setup direto via SQL: ajuste manual não passa custo_unitario, então
    // pra esse cenário injetamos custo via UPSERT direto em siso_custo_medio.
    const { data: produto } = await ctx.sb
      .from("siso_produtos").select("id").eq("sku", sku).single();
    await ctx.sb.from("siso_custo_medio").upsert({
      produto_id: (produto as { id: string }).id,
      custo_medio: 5.0,
      atualizado_em: new Date().toISOString(),
    });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const sessao = await ctx.criarSessaoInventario({
      galpao: "CWB", locs: ["A-01-01"], modo: "aberto",
    });
    await ctx.entrarParty(sessao.id);
    await ctx.proximaLoc(sessao.id);
    await ctx.bipeInventario({ sessao_id: sessao.id, sku, loc: "A-01-01", qty: 12 });
    await ctx.finalizarLocInventario({ sessao_id: sessao.id, loc: "A-01-01" });

    // Defaults da sessão (tolerancia_pct=2.0) marcariam delta=+2 / saldo=10
    // (20%) como pendente, bloqueando o aprovarSessao. Bumpa tolerância pra
    // que a divergência caia em 'aprovada' direto após computarDivergencias.
    await ctx.sb
      .from("siso_inventario_sessoes")
      .update({ tolerancia_pct: 999 })
      .eq("id", sessao.id);

    await ctx.aprovarInventario(sessao.id);
    await ctx.aplicarInventario(sessao.id);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 12);
    // Custo médio deve permanecer 5.0 (ganho com custo_unitario do último entrante)
    await ctx.assertCustoMedio(sku, 5.0, 0.01);

    // Audit do ledger: a mov de inventario_ganho precisa carregar
    // custo_unitario=5.0 (último entrante) — sem isso o histórico fica com
    // custo=null e perdemos a rastreabilidade do valor do ganho.
    const { data: prod } = await ctx.sb
      .from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id, quantidade, custo_unitario, custo_medio_anterior, custo_medio_posterior, origem_tipo")
      .eq("produto_id", (prod as { id: string }).id)
      .eq("origem_tipo", "inventario_ganho")
      .order("criado_em", { ascending: false })
      .limit(1);
    const mov = (movs ?? [])[0] as
      | { custo_unitario: number | string | null; custo_medio_anterior: number | string | null; custo_medio_posterior: number | string | null }
      | undefined;
    if (!mov) throw new Error("assertEsperado: mov inventario_ganho não encontrada");
    const custoUnit = mov.custo_unitario === null ? null : Number(mov.custo_unitario);
    if (custoUnit === null || Math.abs(custoUnit - 5.0) > 0.01) {
      throw new Error(
        `assertEsperado: esperava mov.custo_unitario≈5.0, recebido ${mov.custo_unitario} ` +
        `(custo_medio_anterior=${mov.custo_medio_anterior}, custo_medio_posterior=${mov.custo_medio_posterior})`,
      );
    }
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

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
