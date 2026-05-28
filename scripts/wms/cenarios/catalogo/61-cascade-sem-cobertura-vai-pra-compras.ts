import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "61 — Cascade esgotado oferece Mandar pra Compras",
  descricao:
    "Mudança A (28/05): cascade sem cobertura retorna payload no parcial " +
    "em vez de transitar pra pendente_realocacao automaticamente. Cliente " +
    "chama /mandar-pra-compras → pedido vira aguardando_compra. Sem loop " +
    "infinito via Pendentes.",
  tags: ["separacao", "cascade", "compras", "fase1"],

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
    // O operador chega na loc, vê vazia → parcial qty=0 loc_zerou=true
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 0, loc_zerou: true });

    // O endpoint /parcial retorna sem_cobertura+payload. O cliente
    // chamaria /mandar-pra-compras. Aqui simulamos diretamente via http.
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedido.id)
      .eq("sku", sku)
      .single();

    await ctx.http.post("/api/wms/separacao/mandar-pra-compras", {
      pedido_ids: [pedido.id],
      item_ids: [String(itemRow!.id)],
    });
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

    if (pedRow?.status_separacao !== "aguardando_compra") {
      throw new Error(
        `esperava status_separacao=aguardando_compra, recebi ${pedRow?.status_separacao}`,
      );
    }
    if (itemRow.compra_status !== "aguardando_compra") {
      throw new Error(
        `esperava compra_status=aguardando_compra, recebi ${itemRow.compra_status}`,
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
