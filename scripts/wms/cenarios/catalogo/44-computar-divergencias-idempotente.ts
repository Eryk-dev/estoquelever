import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "44 — computarDivergencias é idempotente em re-execução",
  descricao:
    "Sessão com 1 divergência pendente: chamar /aprovar 2x não duplica linhas em siso_inventario_divergencias. Garante que upsert + delete-non-applied funcionam em re-run.",
  tags: ["inventario", "idempotencia", "computar_divergencias"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("44");
    await ctx.criarProduto({ sku, descricao: "Idempot 44" });
    // Semeia 10 unidades — operador vai bipar 7 (delta -3), gerando 1 divergência pendente.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-44", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Cria sessão de inventário em A-01-44 e conta 7 (diverge de 10)
    const sess = await ctx.criarSessaoInventario({
      galpao: "CWB",
      locs: ["A-01-44"],
      modo: "blind",
      tipo: "cycle_count",
    });
    await ctx.entrarParty(sess.id);
    await ctx.proximaLoc(sess.id);
    await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-44", qty: 7 });
    await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-44" });

    // 2. Primeira chamada de /aprovar → computa divergências (1 pendente).
    await ctx.aprovarInventario(sess.id);

    // Snapshot do count de divergências
    const { count: count1 } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("id", { count: "exact", head: true })
      .eq("sessao_id", sess.id);

    // 3. Segunda chamada — sessão ainda em "revisao" (tem pendente). Deve recomputar
    //    sem duplicar linhas (upsert ON CONFLICT + delete-non-applied).
    await ctx.aprovarInventario(sess.id);

    const { count: count2 } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("id", { count: "exact", head: true })
      .eq("sessao_id", sess.id);

    if ((count1 ?? 0) !== (count2 ?? 0)) {
      throw new Error(
        `idempotência violada: 1ª chamada gerou ${count1} linhas, 2ª gerou ${count2}`,
      );
    }
    if ((count1 ?? 0) !== 1) {
      throw new Error(`esperava 1 divergência pendente, achou ${count1}`);
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo não muda (sessão fica em "revisao", divergência não aplicada).
    await ctx.assertSaldo(sku, "CWB", "A-01-44", 10);
    // Sem mov de inventário (nenhuma divergência foi aplicada).
    const { count } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("origem_tipo", "inventario_perda");
    if ((count ?? 0) > 0) {
      throw new Error(`assertEsperado: esperava 0 movs de inventario_perda, achou ${count}`);
    }
    // E que o estado da divergência seja "pendente"
    const { data } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("status");
    const rows = (data ?? []) as Array<{ status: string }>;
    const pendentes = rows.filter((r) => r.status === "pendente").length;
    if (pendentes !== 1) {
      throw new Error(`assertEsperado: esperava 1 divergência pendente, achou ${pendentes}`);
    }
    // Suprime warning do parâmetro
    void sku;
  },
} satisfies Cenario<{ sku: string }>;

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
