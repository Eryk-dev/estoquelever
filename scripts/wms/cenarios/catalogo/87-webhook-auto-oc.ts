import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "87 — Webhook auto-aprova OC (sem painel)",
  descricao: "Pedido sem saldo em nenhum galpão → auto vira validacao_oc SEM passar por /pedidos/aprovar; sem reserva R; 1 job decisao:oc.",
  tags: ["pedido", "oc", "auto", "webhook"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("87");
    await ctx.criarProduto({ sku, descricao: "OC auto 87" });
    // sem semearSaldo → sem cobertura → roteador decide oc
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 12_000 });
    return { pedidoId: pedido.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Resolve o pedido via SKU do item (siso_pedido_itens tem coluna sku)
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .limit(1)
      .single();
    const pedidoId = (itemRow as { pedido_id: string }).pedido_id;

    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("id, status, decisao_final, status_separacao, marcadores, tipo_resolucao")
      .eq("id", pedidoId)
      .single();
    // Timing hedge: se o worker ainda não rodou, status='executando';
    // após o job lancar_estoque completar (OC), o worker seta 'concluido'.
    // Ambos válidos. status_separacao continua 'validacao_oc' nos dois casos.
    if (ped!.status !== "concluido" && ped!.status !== "executando")
      throw new Error(`status=${ped!.status} esperado concluido ou executando`);
    if (ped!.decisao_final !== "oc") throw new Error(`decisao_final=${ped!.decisao_final} esperado oc`);
    if (ped!.status_separacao !== "validacao_oc") throw new Error(`status_separacao=${ped!.status_separacao}`);
    if (ped!.tipo_resolucao !== "auto") throw new Error(`tipo_resolucao=${ped!.tipo_resolucao} esperado auto`);
    if (!(ped!.marcadores as string[]).includes("OC")) throw new Error(`marcadores sem OC: ${ped!.marcadores}`);

    // 1 job decisao:oc
    const { data: jobs } = await ctx.sb
      .from("siso_fila_execucao")
      .select("id, decisao, tipo")
      .eq("pedido_id", ped!.id)
      .eq("tipo", "lancar_estoque");
    const ocJobs = (jobs ?? []).filter((j: { decisao: string }) => j.decisao === "oc");
    if (ocJobs.length !== 1) throw new Error(`esperado 1 job oc, achou ${ocJobs.length}`);

    // ZERO reserva R
    const { data: rs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("origem_id", ped!.id)
      .eq("tipo", "R");
    if ((rs ?? []).length !== 0) throw new Error(`esperado 0 R, achou ${(rs ?? []).length}`);
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
