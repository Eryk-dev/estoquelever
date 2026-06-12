import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "61 — Cascade esgotado vai pra validação OC (busca física)",
  descricao:
    "Decisão 2026-06-12: cascade sem cobertura de sistema em galpão nenhum " +
    "transita o pedido pra validacao_oc (pick OC) automaticamente no /parcial, " +
    "pra busca física antes de comprar (loc cadastrada pode estar errada). " +
    "Item vira compra_status='oc_pendente'. Sem chamada manual a /mandar-pra-compras.",
  tags: ["separacao", "cascade", "validacao_oc", "compras", "fase1"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("61");
    await ctx.criarProduto({ sku, descricao: "Cascade pra compras 61" });
    // Saldo 1un em CWB; SP fica zerado → cascade não vai achar cobertura
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-04", qty: 1 });
    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    // Pedido tem cobertura — pode auto-aprovar como propria
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);

    // Simula loc fantasma: ajusta -1 antes do operador parcial-loc-zerou
    // (saldo cache 0, mas snapshot do pedido ainda diz "tinha 1").
    // O operador chega na loc, vê vazia → parcial qty=0 loc_zerou=true.
    // Sem cobertura de sistema em galpão nenhum → /parcial auto-transita pra
    // validacao_oc (pick OC) sozinho — sem chamada manual a /mandar-pra-compras.
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 0, loc_zerou: true });
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string }) => {
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id, compra_status, compra_quantidade_solicitada")
      .eq("sku", sku)
      .maybeSingle();
    if (!itemRow?.pedido_id) throw new Error("item não encontrado");

    const { data: pedRow } = await ctx.sb
      .from("siso_pedidos")
      .select("status, status_separacao")
      .eq("id", itemRow.pedido_id)
      .single();

    if (pedRow?.status_separacao !== "validacao_oc") {
      throw new Error(
        `esperava status_separacao=validacao_oc, recebi ${pedRow?.status_separacao}`,
      );
    }
    if (itemRow.compra_status !== "oc_pendente") {
      throw new Error(
        `esperava compra_status=oc_pendente, recebi ${itemRow.compra_status}`,
      );
    }
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

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
