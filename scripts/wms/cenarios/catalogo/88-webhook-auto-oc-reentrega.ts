import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "88 — Webhook auto-OC re-entrega (idempotente)",
  descricao: "Mesmo pedido Tiny entregue 2× via webhook; dedup garante 1 job oc na fila e pedido em validacao_oc.",
  tags: ["pedido", "oc", "auto", "webhook", "idempotencia"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("88");
    await ctx.criarProduto({ sku, descricao: "OC auto reentrega 88" });
    // sem semearSaldo → sem cobertura → roteador decide oc
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Primeira entrega
    const pedido1 = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });

    // Aguarda o job processar e setar validacao_oc antes da re-entrega
    await ctx.aguardarStatusSeparacao(pedido1.id, "validacao_oc", { timeout_ms: 15_000 });

    // Re-entrega com o MESMO id de pedido Tiny
    await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
      pedidoFakeId: Number(pedido1.id),
    });

    // Aguarda processamento da re-entrega (breve)
    await ctx.aguardar(3_000);

    return { pedidoId: pedido1.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Resolve pedido via SKU do item
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .limit(1)
      .single();
    const pedidoId = (itemRow as { pedido_id: string }).pedido_id;

    // Pedido deve estar em validacao_oc com decisao_final=oc
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("id, status, decisao_final, status_separacao, tipo_resolucao, marcadores")
      .eq("id", pedidoId)
      .single();

    if (ped!.decisao_final !== "oc")
      throw new Error(`decisao_final=${ped!.decisao_final} esperado oc`);
    if (ped!.status_separacao !== "validacao_oc")
      throw new Error(`status_separacao=${ped!.status_separacao} esperado validacao_oc`);
    if (ped!.tipo_resolucao !== "auto")
      throw new Error(`tipo_resolucao=${ped!.tipo_resolucao} esperado auto`);

    // Dedup: deve existir EXATAMENTE 1 job lancar_estoque (qualquer status)
    const { data: jobs } = await ctx.sb
      .from("siso_fila_execucao")
      .select("id, decisao, tipo, status")
      .eq("pedido_id", ped!.id)
      .eq("tipo", "lancar_estoque");

    const ocJobs = (jobs ?? []).filter((j: { decisao: string }) => j.decisao === "oc");
    if (ocJobs.length !== 1)
      throw new Error(`esperado 1 job oc (dedup), achou ${ocJobs.length}`);

    // ZERO reserva R
    const { data: rs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("origem_id", ped!.id)
      .eq("tipo", "R");
    if ((rs ?? []).length !== 0)
      throw new Error(`esperado 0 R, achou ${(rs ?? []).length}`);
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
