import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "10 — Devolução cliente íntegra (A)",
  descricao: "NF entrada categoria A → mov com custo_unitario → siso_custo_medio recalculado.",
  tags: ["devolucao", "categoria_a", "custo_medio", "entrada"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("10");
    await ctx.criarProduto({ sku, descricao: "Devol A 10" });
    // Estado inicial: 10 unidades a 8 reais (vamos "vender" 2 a 14 abaixo,
    // sobram 8 pre-devolução; depois da devolução A volta pros 10 esperados).
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-08", qty: 10, custo: 8 });

    // Cria NF de devolução simulada (insert direto). A tabela só tem
    // metadata da NF — produto/loc/qty viajam no `payload_webhook`
    // (jsonb) e a rota /classificar lê tudo do body do request, que o
    // helper monta a partir desse payload.
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-01-08")
      .single();
    // Pra que `classificarDevolucao` herde custo_unitario=14, ele precisa
    // dum `pedido_origem_mov_id` apontando pra uma mov com custo=14. A lib
    // não valida produto, então criamos uma mov SINTÉTICA em outro produto
    // (descartável "produto-sentinel-10"), evitando S movs no produto sob
    // teste — assim RPC formula e I3 invariante batem certinho:
    //   E 10@8 (seed) + E 2@14 (devolucao) = (80+28)/12 = 9.
    const sentinelSku = ctx.skuUnico("10-sentinel");
    await ctx.criarProduto({ sku: sentinelSku, descricao: "sentinel-10" });
    await ctx.semearSaldo({ produto: sentinelSku, galpao: "CWB", loc: "B-02-05", qty: 5 });
    const { data: sentProd } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sentinelSku).single();
    const { data: sentLoc } = await ctx.sb.from("siso_localizacoes").select("id").eq("galpao_id", ctx.staging.galpoes.cwb.id).eq("codigo", "B-02-05").single();
    const { data: vendaMovId, error: vendaErr } = await ctx.sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: sentProd!.id,
      p_galpao_id: ctx.staging.galpoes.cwb.id,
      p_localizacao_id: sentLoc!.id,
      p_tipo: "S",
      p_quantidade: 2,
      p_origem_tipo: "nf_venda",
      p_custo_unitario: 14,
      p_empresa_vendedora_id: ctx.staging.empresas.netair.id,
      p_motivo: "venda sintética sentinel (harness setup p/ herdar custo)",
    });
    if (vendaErr) throw new Error(`venda mov setup: ${vendaErr.message}`);

    const { data: dev } = await ctx.sb.from("siso_devolucoes_pendentes").insert({
      empresa_id: ctx.staging.empresas.netair.id,
      pedido_origem_mov_id: vendaMovId,
      status: "aguardando_classificacao",
      chave_acesso_nf: `TEST-NF-${ctx.skuUnico("nf")}`,
      payload_webhook: {
        produto_id: prod!.id,
        galpao_id: ctx.staging.galpoes.cwb.id,
        localizacao_id: loc!.id,
        qty: 2,
        valor_unitario: 14,
        cliente_nome: "Cliente teste",
      },
    }).select("id").single();

    return { sku, devolucaoId: dev!.id as string };
  },

  run: async (ctx, { devolucaoId }) => {
    await ctx.classificarDevolucao({ devolucao_id: devolucaoId, classificacao: "A" });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Seed 10@8, devolucao A 2@14 → saldo final 12.
    // Custo médio: 10 a 8 + 2 a 14 → (80 + 28) / 12 = 9 (RPC e I3 batem).
    await ctx.assertSaldo(sku, "CWB", "A-01-08", 12);
    await ctx.assertCustoMedio(sku, 9, 0.01);
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
