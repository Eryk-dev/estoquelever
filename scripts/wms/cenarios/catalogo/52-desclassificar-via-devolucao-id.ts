import type { Cenario, Ctx } from "../_harness/types";

/**
 * fix-final-B T11 — devolucao_id em movs + lookup determinístico
 *
 * Valida que:
 *   1. classificarDevolucao (classe B — avariada) popula `devolucao_id`
 *      em todas as movs geradas (E + par S+E quarentena).
 *   2. desclassificarDevolucao usa o FK determinístico (não janela temporal)
 *      — ou seja, encontra exatamente as movs pelo devolucao_id e as estorna.
 *   3. Após desclassificar: saldo volta ao original, QUARENTENA zerada,
 *      status da devolução = 'aguardando_classificacao'.
 *   4. I1-I7 verde.
 */
export default {
  nome: "52 — Desclassificar via devolucao_id (lookup determinístico)",
  descricao: "Classe B → assert devolucao_id em movs → desclassificar determinístico → saldo volta.",
  tags: ["devolucao", "desclassificar", "devolucao_id", "fix-final-b", "t11"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("52");
    await ctx.criarProduto({ sku, descricao: "Devol devolucao_id 52" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-05", qty: 10, custo: 20 });

    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-01-05")
      .single();

    const { data: dev } = await ctx.sb
      .from("siso_devolucoes_pendentes")
      .insert({
        empresa_id: ctx.staging.empresas.netair.id,
        status: "aguardando_classificacao",
        chave_acesso_nf: `TEST-NF-52-${ctx.skuUnico("nf")}`,
        payload_webhook: {
          produto_id: prod!.id,
          galpao_id: ctx.staging.galpoes.cwb.id,
          localizacao_id: loc!.id,
          qty: 3,
          valor_unitario: 20,
          cliente_nome: "Cliente cenario 52",
        },
      })
      .select("id")
      .single();

    return { sku, produtoId: prod!.id as string, devolucaoId: dev!.id as string };
  },

  run: async (ctx, { devolucaoId }) => {
    // 1. Classifica como B (avariado) → gera E na loc + par S+E pra quarentena
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "B" });
    ctx.log("classificarDevolucao(B) OK");

    // 2. Desclassifica — lookup determinístico via devolucao_id
    const r = await ctx.desclassificarDevolucao({
      devolucao_id: devolucaoId,
      motivo: "cenário 52 — valida lookup determinístico por devolucao_id",
    });
    if (!r || typeof r.movsEstornadas !== "number" || r.movsEstornadas < 1) {
      throw new Error(
        `desclassificar deveria estornar ≥1 mov via devolucao_id; retornou ${JSON.stringify(r)}`,
      );
    }
    ctx.log(`desclassificar OK — movsEstornadas=${r.movsEstornadas}`);
  },

  assertEsperado: async (ctx, { sku, produtoId, devolucaoId }) => {
    // 1. Saldo na loc original deve ter voltado ao inicial (10)
    //    (as 3 unidades que entraram foram estornadas)
    await ctx.assertSaldo(sku, "CWB", "A-01-05", 10);

    // 2. QUARENTENA deve estar zerada (S+E da classe B foi estornado)
    await ctx.assertSaldo(sku, "CWB", "QUARENTENA", 0);

    // 3. Devolução de volta a aguardando_classificacao
    const { data: dev } = await ctx.sb
      .from("siso_devolucoes_pendentes")
      .select("status, classificacao")
      .eq("id", devolucaoId)
      .single();
    const row = dev as { status: string; classificacao: string | null };
    if (row.status !== "aguardando_classificacao") {
      throw new Error(
        `devolução deve estar 'aguardando_classificacao' após desclassificar; got ${row.status}`,
      );
    }
    if (row.classificacao !== null) {
      throw new Error(
        `classificacao deve ser null após desclassificar; got ${row.classificacao}`,
      );
    }

    // 4. Assert determinístico: movs geradas pela classificação devem ter
    //    devolucao_id populado (confirma que classificarDevolucao as marcou).
    //    Após desclassificar, essas movs foram estornadas — os estornos
    //    (estorno_de IS NOT NULL) não têm devolucao_id. As movs originais
    //    (estorno_de IS NULL) com devolucao_id agora estão estornadas.
    const { data: movsOriginais, error: errMovs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id, tipo, origem_tipo, estorno_de, devolucao_id")
      .eq("produto_id", produtoId)
      .eq("devolucao_id", devolucaoId)
      .is("estorno_de", null);

    if (errMovs) throw new Error(`Falha ao buscar movs: ${errMovs.message}`);
    const originals = (movsOriginais ?? []) as Array<{
      id: string;
      tipo: string;
      origem_tipo: string;
      estorno_de: string | null;
      devolucao_id: string | null;
    }>;

    // Deve haver ≥1 mov original com devolucao_id para este produto
    if (originals.length === 0) {
      throw new Error(
        `Nenhuma mov com devolucao_id=${devolucaoId} encontrada — ` +
        `classificarDevolucao não populou devolucao_id nas movs`,
      );
    }
    ctx.log(`movs originais com devolucao_id: ${originals.length}`, {
      ids: originals.map((m) => m.id),
      tipos: originals.map((m) => m.tipo),
      origem_tipos: originals.map((m) => m.origem_tipo),
    });

    // Todas essas movs originais devem ter devolucao_id correto
    for (const m of originals) {
      if (m.devolucao_id !== devolucaoId) {
        throw new Error(
          `mov ${m.id} tem devolucao_id=${m.devolucao_id}, esperado ${devolucaoId}`,
        );
      }
    }

    // 5. Verifica que as movs originais possuem pares de estorno
    //    (estornarMovimentacao cria movs com estorno_de = m.id)
    for (const m of originals) {
      const { data: estorno } = await ctx.sb
        .from("siso_movimentacoes")
        .select("id")
        .eq("estorno_de", m.id)
        .maybeSingle();
      if (!estorno) {
        throw new Error(
          `mov original ${m.id} (${m.origem_tipo}) não tem par de estorno — ` +
          `desclassificar não estornou via devolucao_id`,
        );
      }
    }
    ctx.log("assert determinístico OK — todas movs originais têm par estorno");
  },
} satisfies Cenario<{ sku: string; produtoId: string; devolucaoId: string }>;

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
