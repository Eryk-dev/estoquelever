import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "28 — DELETE realocação cancelada libera R cascade",
  descricao:
    "Quando uma realocação aguardando_picking é cancelada, qualquer R " +
    "criada pra ela deve ser liberada via per-R estornarReservaIndividual. " +
    "Hoje só muda status — R fica órfã.",
  tags: ["separacao", "realocacao", "reserva", "cascade"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("28");
    await ctx.criarProduto({ sku, descricao: "Realoc 28" });
    // Topologia inspirada nos cenários 04/21. Roteamento pega A-01-01 (maior
    // saldo) pra R original; parcial+loc_zerou roda sobre a loc do
    // siso_pedido_item_estoques (A-01-02, a "primária" do tiny-stub) e o
    // cascade re-emite R em A-01-01 (única com saldo). Resultado pré-DELETE:
    //   - A-01-02: saldo=0, reservado=0
    //   - A-01-01: saldo=5, reservado=5 (R original 3 + R cascade 2 — ambas
    //     "do pedido" no ledger). DELETE deve liberar ambas (plano explicita:
    //     per-R loop varre todas as Rs abertas do pedido).
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 3 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);

    // Parcial qty=1 + loc_zerou na loc primária → ajuste pra 0 + cascade
    // pro residual (2). Cascade aterra em A-01-01 (única com saldo).
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 1, loc_zerou: true });
    await ctx.aguardarRealocacao(pedido.id, sku, "A-01-01");

    const { data: realoc } = await ctx.sb
      .from("siso_pedido_item_realocacoes")
      .select("id")
      .eq("status", "aguardando_picking")
      .limit(1)
      .single();
    if (!realoc) throw new Error("realocacao aguardando_picking não encontrada");

    // DELETE realocação — deve cancelar o status E liberar Rs abertas do pedido.
    await ctx.http.delete(`/api/wms/separacao/realocacao/${(realoc as { id: string }).id}`);
  },

  assertEsperado: async (ctx, { sku }) => {
    // Rs do pedido (originalmente reservado=5 em A-01-01) devem estar
    // 100% liberadas. Pré-fix: reservado fica em 5 (R órfã). Pós-fix: 0.
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
