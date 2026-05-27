import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 29 — devolução `classificacao='troca_sku'` grava
 * `origem_tipo='devolucao_cliente_troca_sku'` (novo valor dedicado, antes
 * era misturado com Classe A 'devolucao_cliente_integra').
 *
 * Cria devolução pendente (siso_devolucoes_pendentes), POSTa classificar
 * com classificacao='troca_sku' + tripla destino, e checa que a última mov
 * no produto carrega origem_tipo='devolucao_cliente_troca_sku'.
 */
export default {
  nome: "29 — devolução troca_sku usa origem_tipo distinto",
  descricao:
    "Classificar devolução como troca_sku grava origem_tipo='devolucao_cliente_troca_sku' (separa de Classe A íntegro pra apuração).",
  tags: ["devolucoes", "troca-sku", "origem-tipo", "p6"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("29");
    const locCodigo = `A-01-01`;

    await ctx.criarProduto({ sku, descricao: "Devolução troca_sku 29" });
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produtoId = (produto as { id: string }).id;

    const galpaoCwbId = ctx.staging.galpoes.cwb.id;
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", galpaoCwbId)
      .eq("codigo", locCodigo)
      .single();
    const locId = (loc as { id: string }).id;

    // Cria devolução pendente — payload mínimo (campos obrigatórios:
    // payload_webhook tem default '{}', status default
    // 'aguardando_classificacao'). Não setamos pedido_origem_mov_id ou
    // empresa_referencia_id (a lib lida com null).
    const notaFakeId = Math.floor(Math.random() * 90_000_000) + 9_000_000_000;
    const { data: dev, error: devErr } = await ctx.sb
      .from("siso_devolucoes_pendentes")
      .insert({
        nota_fiscal_id: notaFakeId,
        empresa_id: ctx.staging.empresas.netair.id,
        payload_webhook: { stub: true, cenario: "29" },
      })
      .select("id")
      .single();
    if (devErr) throw new Error(`criar devolução: ${devErr.message}`);
    const devolucaoId = (dev as { id: string }).id;

    return { sku, produtoId, galpaoCwbId, locId, locCodigo, devolucaoId };
  },

  run: async (ctx, { produtoId, galpaoCwbId, locId, devolucaoId }) => {
    await ctx.http.post(`/api/wms/devolucoes/${devolucaoId}/classificar`, {
      classificacao: "troca_sku",
      produto_id: produtoId,
      galpao_id: galpaoCwbId,
      localizacao_id: locId,
      qty: 1,
      observacoes: "cenário 29 — troca_sku",
    });
  },

  assertEsperado: async (ctx, { produtoId }) => {
    // Última mov do produto deve ser do tipo entrada com
    // origem_tipo='devolucao_cliente_troca_sku'.
    const { data: movs, error } = await ctx.sb
      .from("siso_movimentacoes")
      .select("origem_tipo, tipo")
      .eq("produto_id", produtoId)
      .order("criado_em", { ascending: false })
      .limit(5);
    if (error) throw new Error(`select movs: ${error.message}`);
    const list = (movs as Array<{ origem_tipo: string; tipo: string }>) ?? [];
    const found = list.some(
      (m) => m.origem_tipo === "devolucao_cliente_troca_sku" && m.tipo === "E",
    );
    if (!found) {
      throw new Error(
        `mov 'E' com origem_tipo=devolucao_cliente_troca_sku não encontrada; últimas: ${JSON.stringify(list)}`,
      );
    }
  },
} satisfies Cenario<{
  sku: string;
  produtoId: string;
  galpaoCwbId: string;
  locId: string;
  locCodigo: string;
  devolucaoId: string;
}>;

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
