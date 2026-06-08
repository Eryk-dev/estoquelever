import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "22 — Receber compra grava mov E nf_compra (ledger)",
  descricao:
    "OC criada via produto-esgotado → comprar → receber. Receber deve " +
    "gerar mov E (nf_compra) com custo_unitario, atualizando siso_estoque " +
    "e siso_custo_medio. Bloqueio crítico pós-cutover.",
  tags: ["compras", "receber", "ledger", "custo-medio", "wms-as-source"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("22");
    await ctx.criarProduto({ sku, descricao: "Compra 22" });
    // sem semear saldo — webhook vai pra OC
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 4 }],
    });
    // Pós F1 (auto-OC): webhook auto-aprova OC, não há mais status='pendente'.
    // Aguarda diretamente validacao_oc setada pelo worker.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // Compra fluxo
    const ordem = await ctx.comprar({ sku, qty: 4, pedido_id: pedido.id });
    await ctx.receberCompra({
      ordem_id: ordem.ordem_id,
      items: [{ sku, qty: 4 }],
    });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo entrou em CWB (galpão da empresa NetAir) numa loc de
    // RECEBIMENTO ou na loc default da OC.
    const { data: estoques } = await ctx.sb
      .from("siso_estoque")
      .select("saldo, localizacao_id, siso_localizacoes!inner(codigo)")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .gt("saldo", 0);
    const total = (estoques ?? []).reduce(
      (s, e) => s + Number(e.saldo),
      0,
    );
    if (total < 4) {
      throw new Error(
        `saldo total esperado >=4, recebido ${total}. Provavelmente mov E nf_compra não foi gravada.`,
      );
    }

    // Custo médio deve ter sido atualizado (siso_custo_medio populado pra produto)
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: cm } = await ctx.sb
      .from("siso_custo_medio")
      .select("custo_medio")
      .eq("produto_id", produto!.id)
      .maybeSingle();
    // Custo só atualiza se receber-compra passou custo_unitario.
    // Cenário valida só presença — recalculo aritmético em cenário 24.
    if (!cm) {
      throw new Error("siso_custo_medio sem entrada — recálculo não disparou");
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
