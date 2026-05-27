import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #6.3 — Desclassificar devolução
 *
 * Fluxo:
 *   1. semearSaldo CWB/A-01-04 = 5 unidades
 *   2. classificar como 'A' (integro) → +2 unidades = 7
 *   3. desclassificar → estorna a mov → saldo volta pra 5
 *   4. re-classificar como 'B' (avariado) → entra em A-01-04 e
 *      transfere imediatamente pra QUARENTENA (par S+E)
 *      → A-01-04 = 5, QUARENTENA = 2
 */
export default {
  nome: "43 — Desclassificar devolução",
  descricao: "Classe A → desclassifica (saldo volta) → re-classifica como B (quarentena).",
  tags: ["devolucao", "desclassificar", "estorno", "p3"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("43");
    await ctx.criarProduto({ sku, descricao: "Devol desclass 43" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-04", qty: 5, custo: 10 });

    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-01-04")
      .single();

    const { data: dev } = await ctx.sb
      .from("siso_devolucoes_pendentes")
      .insert({
        empresa_id: ctx.staging.empresas.netair.id,
        status: "aguardando_classificacao",
        chave_acesso_nf: `TEST-NF-43-${ctx.skuUnico("nf")}`,
        payload_webhook: {
          produto_id: prod!.id,
          galpao_id: ctx.staging.galpoes.cwb.id,
          localizacao_id: loc!.id,
          qty: 2,
          valor_unitario: 10,
          cliente_nome: "Cliente desclassifica teste",
        },
      })
      .select("id")
      .single();

    return { sku, devolucaoId: dev!.id as string };
  },

  run: async (ctx, { sku, devolucaoId }) => {
    // 1. Classifica como A → +2 unidades (saldo 5 → 7)
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "A" });
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 7);

    // 2. Desclassifica → estorna a mov de entrada → saldo volta pra 5
    const r = await ctx.desclassificarDevolucao({
      devolucao_id: devolucaoId,
      motivo: "cenário 43 — operador errou classificação, undo",
    });
    if (!r || typeof r.movsEstornadas !== "number" || r.movsEstornadas < 1) {
      throw new Error(
        `desclassificar deveria estornar ≥1 mov; retornou ${JSON.stringify(r)}`,
      );
    }
    ctx.log(`desclassificar OK — movsEstornadas=${r.movsEstornadas}`);

    // 3. Re-classifica como B (Task 48) → entra na loc original e
    //    transfere imediatamente pra QUARENTENA (par S+E)
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "B" });
  },

  assertEsperado: async (ctx, { sku, devolucaoId }) => {
    // Após o fluxo completo:
    //   - A-01-04 fica em 5 (saldo intacto: re-classificar como B entrou
    //     2 e tirou 2 pra quarentena)
    //   - QUARENTENA fica em 2 (saldo da reclassificação como B)
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 5);
    await ctx.assertSaldo(sku, "CWB", "QUARENTENA", 2);

    // Devolução deve ter sido re-classificada (Task 48)
    const { data: dev } = await ctx.sb
      .from("siso_devolucoes_pendentes")
      .select("status, classificacao")
      .eq("id", devolucaoId)
      .single();
    const row = dev as { status: string; classificacao: string | null };
    if (row.status !== "classificada") {
      throw new Error(`devolução deve estar 'classificada' após re-classificar (B); got ${row.status}`);
    }
    if (row.classificacao !== "avariado") {
      throw new Error(`classificacao final deve ser 'avariado' (B); got ${row.classificacao}`);
    }
  },
} satisfies Cenario<{ sku: string; devolucaoId: string }>;

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
