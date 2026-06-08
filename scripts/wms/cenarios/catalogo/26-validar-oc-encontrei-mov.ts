import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "26 — validar-oc-item 'encontrei' gera par S+L",
  descricao:
    "Pedido OC, depois op encontra fisicamente o item — deve gerar par S+L " +
    "como qualquer pick normal, senão a baixa nunca ocorre no ledger.",
  tags: ["separacao", "validar-oc-item", "encontrei", "ledger"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("26");
    await ctx.criarProduto({ sku, descricao: "Encontrei 26" });
    // Sem saldo → vai pra OC
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    // Pós F1 (auto-OC): webhook auto-aprova OC, aguarda diretamente validacao_oc.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // Agora "encontra" — pre-condição: precisa ter saldo agora (ajuste pra setup do estoque)
    await ctx.ajusteManual({
      sku,
      galpao: "CWB",
      loc: "DEFAULT-PICKING",
      delta: 1,
      motivo: "Achado físico antes da OC chegar",
    });

    // Fetch item id
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedido.id)
      .single();

    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [item!.id],
      acao: "encontrei",
    });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo: ajuste +1 - encontrei -1 = 0
    await ctx.assertSaldo(sku, "CWB", "DEFAULT-PICKING", 0);
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, origem_tipo")
      .eq("produto_id", produto!.id);
    const movsS = (movs ?? []).filter(
      (m) => m.tipo === "S" && m.origem_tipo === "nf_venda",
    );
    if (movsS.length === 0) {
      throw new Error("encontrei não gerou mov S nf_venda — bug #2.6");
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
