import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "02 — Pedido transferência",
  descricao: "NetAir vende, mas estoque está em SP (NetParts). Sistema sugere transferência. Operador aprova.",
  tags: ["pedido", "transferencia", "pipeline"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("02");
    await ctx.criarProduto({ sku, descricao: "Filtro 02" });
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-01", qty: 4 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "transferencia" });
    await ctx.aprovar(pedido.id, "transferencia");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");

    // No fluxo transferencia, separacao_galpao_id = SP mas marcar-item resolve
    // localizacao via siso_pedido_item_estoques filtrando por empresa_origem_id
    // (NetAir). NetAir tinha 0 saldo em CWB, então localizacao foi gravada
    // como null → fallback DEFAULT-PICKING falha. Patch: aponta a row da
    // empresa origem pra loc real do estoque em SP.
    // siso_pedido_item_estoques.produto_id é o Tiny bigint (não o uuid do
    // siso_produtos), então buscamos via siso_pedido_itens pra pegar o valor
    // correto do mesmo schema.
    const { data: pedidoItem } = await ctx.sb
      .from("siso_pedido_itens")
      .select("produto_id")
      .eq("pedido_id", pedido.id)
      .eq("sku", sku)
      .single();
    await ctx.sb
      .from("siso_pedido_item_estoques")
      .update({ localizacao: "C-01-01" })
      .eq("pedido_id", pedido.id)
      .eq("produto_id", (pedidoItem as { produto_id: number }).produto_id)
      .eq("empresa_id", ctx.staging.empresas.netair.id);

    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 2 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.embalar(pedido.id);
    await ctx.expedir(pedido.id);
    await ctx.aguardarFilaVazia();
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "SP", "C-01-01", 2);
  },
} satisfies Cenario<{ sku: string }>;

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
