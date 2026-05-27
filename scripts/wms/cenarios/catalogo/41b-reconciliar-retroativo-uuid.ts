import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "41b — Reconciliar retroativo valida uuid + existência",
  descricao:
    "POST /api/wms/lancamento-retroativo/[id]/reconciliar com compra_mov_id inválido (não-uuid) deve retornar 400; com uuid válido mas sem mov correspondente deve retornar 404. Nenhum estorno deve ser criado durante as falhas.",
  tags: ["p3", "retroativo", "validation", "guard"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("41b");
    await ctx.criarProduto({ sku, descricao: "P3-41b Reconciliar retroativo UUID" });
    // custo=10 nos dois seeds pra não quebrar I3 (custo médio coerente).
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10, custo: 10 });

    // Conta movs origem_tipo='estorno' antes de tentar reconciliar — assert
    // pós-falha precisa garantir que ninguém estornou nada.
    const { count: estornosPre } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("origem_tipo", "estorno");
    return { sku, estornosPre: estornosPre ?? 0 };
  },

  run: async (ctx, { sku }) => {
    // Cria 1 lançamento retroativo pra ter um id válido alvo da reconciliação.
    const pend = await ctx.lancamentoRetroativo({
      sku,
      galpao: "CWB",
      loc: "A-01-01",
      qty: 5,
      tipo: "E",
      custo: 10,
    });

    // Caso A — uuid sintaticamente inválido → 400 com mensagem mencionando uuid.
    let erroA: Error | null = null;
    try {
      await ctx.http.post(`/api/wms/lancamento-retroativo/${pend.id}/reconciliar`, {
        compra_mov_id: "abc-not-uuid",
      });
    } catch (e) {
      erroA = e as Error;
    }
    if (!erroA) {
      throw new Error("caso A: POST com uuid inválido deveria ter retornado 400 mas passou");
    }
    if (!/400/.test(erroA.message)) {
      throw new Error(`caso A: esperava 400, achou: ${erroA.message}`);
    }
    if (!/uuid/i.test(erroA.message)) {
      throw new Error(`caso A: esperava mensagem citando 'uuid', achou: ${erroA.message}`);
    }

    // Caso B — uuid v4 válido sintaticamente mas mov não existe → 404 (ou 400)
    // com mensagem indicando não existe.
    let erroB: Error | null = null;
    try {
      await ctx.http.post(`/api/wms/lancamento-retroativo/${pend.id}/reconciliar`, {
        compra_mov_id: "00000000-0000-4000-a000-000000000000",
      });
    } catch (e) {
      erroB = e as Error;
    }
    if (!erroB) {
      throw new Error("caso B: POST com uuid inexistente deveria ter falhado mas passou");
    }
    if (!/40[04]/.test(erroB.message)) {
      throw new Error(`caso B: esperava 404 (ou 400), achou: ${erroB.message}`);
    }
    if (!/(não existe|nao existe|not.?exist)/i.test(erroB.message)) {
      throw new Error(
        `caso B: esperava mensagem indicando que mov não existe, achou: ${erroB.message}`,
      );
    }
  },

  assertEsperado: async (ctx, { sku, estornosPre }) => {
    // Nenhuma das duas tentativas falhas pode ter criado mov origem_tipo='estorno'.
    const { count: estornosPos } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("origem_tipo", "estorno");
    if ((estornosPos ?? 0) !== estornosPre) {
      throw new Error(
        `esperava count(estorno) inalterado (${estornosPre}), achou ${estornosPos ?? 0} — guard falhou`,
      );
    }

    // Saldo deve ser 15 (10 seed + 5 retroativo, sem estorno).
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 15);
  },
} satisfies Cenario<{ sku: string; estornosPre: number }>;

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
