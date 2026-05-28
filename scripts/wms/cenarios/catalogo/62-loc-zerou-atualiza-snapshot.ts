import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "62 — loc_zerou atualiza snapshot do pedido",
  descricao:
    "Mudança B (28/05): mov ajuste_pick_zerou também atualiza " +
    "siso_pedido_item_estoques.disponivel. Sem isso, qualquer " +
    "re-processamento (worker, re-aprovação) vê snapshot velho do " +
    "webhook ('tinha 1') e degrada OC pra Própria → loop infinito.",
  tags: ["separacao", "parcial", "snapshot", "fase1"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("62");
    await ctx.criarProduto({ sku, descricao: "Snapshot sync 62" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 1 });
    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");

    // Snapshot inicial deve ter disp=1 (saldo seedado)
    const { data: snap0 } = await ctx.sb
      .from("siso_pedido_item_estoques")
      .select("disponivel")
      .eq("pedido_id", pedido.id)
      .single();
    if (Number(snap0?.disponivel ?? -1) !== 1) {
      throw new Error(`snapshot inicial esperava 1, recebeu ${snap0?.disponivel}`);
    }

    await ctx.iniciarSeparacao(pedido.id);
    // Marca parcial loc_zerou — gera mov ajuste_pick_zerou + sync do snapshot
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 0, loc_zerou: true });
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string }) => {
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .maybeSingle();
    if (!itemRow?.pedido_id) throw new Error("item não encontrado");

    const { data: snap1 } = await ctx.sb
      .from("siso_pedido_item_estoques")
      .select("disponivel")
      .eq("pedido_id", itemRow.pedido_id)
      .single();
    if (Number(snap1?.disponivel ?? -1) !== 0) {
      throw new Error(
        `snapshot pós loc_zerou esperava 0, recebeu ${snap1?.disponivel}`,
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
