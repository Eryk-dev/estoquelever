import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "11 — Devolução cliente avariada (B/C/D)",
  descricao: "NF entrada categoria B → transfer pra QUARENTENA, saldo na picking intacto.",
  tags: ["devolucao", "categoria_b", "quarentena", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("11");
    await ctx.criarProduto({ sku, descricao: "Devol B 11" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-09", qty: 5, custo: 10 });

    // Tabela `siso_devolucoes_pendentes` em 3D só carrega metadata da NF.
    // Quantidade, produto, galpão e localização viajam no `payload_webhook`
    // — helper `classificarDevolucao` lê esse jsonb e injeta no body do
    // request pra rota /classificar.
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-01-09")
      .single();
    const { data: dev } = await ctx.sb.from("siso_devolucoes_pendentes").insert({
      empresa_id: ctx.staging.empresas.netair.id,
      status: "aguardando_classificacao",
      chave_acesso_nf: `TEST-NF-B-${ctx.skuUnico("nf")}`,
      payload_webhook: {
        produto_id: prod!.id,
        galpao_id: ctx.staging.galpoes.cwb.id,
        localizacao_id: loc!.id,
        qty: 1,
        valor_unitario: 10,
        cliente_nome: "Cliente avariada",
      },
    }).select("id").single();
    return { sku, devolucaoId: dev!.id as string };
  },

  run: async (ctx, { devolucaoId }) => {
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "B" });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-09", 5); // intacto
    await ctx.assertSaldo(sku, "CWB", "QUARENTENA", 1);
    await ctx.assertCustoMedio(sku, 10, 0.01); // custo médio NÃO mudou (categoria B não recalcula)
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
