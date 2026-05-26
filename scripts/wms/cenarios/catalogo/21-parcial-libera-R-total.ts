import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "21 — Parcial libera R total + cascade re-emite R, reservado final=0",
  descricao:
    "Pedido 5un, R criada em loc A-01-02 (3un disponível). Operador pega 2, " +
    "loc zerou. Parcial deve liberar 100% da R em A-01-02 (mesmo só pegando " +
    "2<3) e o cascade re-emite R nova em A-01-01 (3un). Após marcar realocação, " +
    "reservado_total=0 e sem reserva órfã.",
  tags: ["separacao", "parcial", "realocacao", "reserva", "wms-as-source"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("21");
    await ctx.criarProduto({ sku, descricao: "Parcial-R 21" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 3 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);

    // Parcial pega 2 (loc_zerou). Cascade busca residual=3 → A-01-01.
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 2, loc_zerou: true });
    await ctx.aguardarRealocacao(pedido.id, sku, "A-01-01");

    // Verifica invariantes intermediárias:
    // - A-01-02: saldo 0 (S=2 + ajuste_pick_zerou=1), reservado 0 (R original liberada 100%)
    // - A-01-01: saldo 3 (intacto), reservado 3 (R cascade do residual)
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 0);
    await ctx.assertReservado(sku, "CWB", "A-01-02", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 3);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    // Marcar realocação: L (libera R cascade) + S em A-01-01. Saldo 3→0, reservado 3→0.
    const { data: realocs } = await ctx.sb
      .from("siso_pedido_item_realocacoes")
      .select("id")
      .eq("status", "aguardando_picking")
      .order("criado_em", { ascending: false })
      .limit(1);
    const realocId = (realocs as Array<{ id: string }> | null)?.[0]?.id;
    if (!realocId) throw new Error("realocacao recém-criada não encontrada");
    await ctx.http.post("/api/wms/separacao/marcar-realocacao", { realocacao_id: realocId });

    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado");
  },

  assertEsperado: async (ctx, { sku }) => {
    // Ambas as locs zeradas, sem reservado pendurado
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 0);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);
    await ctx.assertReservado(sku, "CWB", "A-01-02", 0);
    await ctx.assertSemReservasOrfas();
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
