import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "32 — Aprovar transferência usa rotearPedidoDoBanco (saldo real)",
  descricao:
    "NetAir recebe pedido sem saldo em CWB; NetParts (SP) tem saldo. " +
    "Aprovar como transferência deve escolher SP via rotearPedidoDoBanco " +
    "(geo-priority + saldo real), não via getEmpresasDoGrupo legacy.",
  tags: ["pedidos", "aprovar", "transferencia", "roteamento"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("32");
    await ctx.criarProduto({ sku, descricao: "Transf 32" });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente");
    await ctx.aprovar(pedido.id, "transferencia");
    await ctx.aguardarStatus(pedido.id, "executando");
  },

  assertEsperado: async (ctx, { sku }) => {
    const { data: pedidos } = await ctx.sb
      .from("siso_pedidos")
      .select("id, separacao_galpao_id")
      .eq("decisao_final", "transferencia")
      .limit(1);
    const galpaoSep = (pedidos ?? [])[0]?.separacao_galpao_id;
    if (galpaoSep !== ctx.staging.galpoes.sp.id) {
      throw new Error(
        `esperava separacao_galpao_id = SP (${ctx.staging.galpoes.sp.id}), recebido ${galpaoSep}`,
      );
    }
    // R reservada em SP (não CWB)
    await ctx.assertReservado(sku, "SP", "C-01-01", 2);
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
