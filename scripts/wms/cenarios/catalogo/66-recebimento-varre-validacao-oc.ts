import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "66 — Recebimento varre pedidos em Validação OC (Decisão 5)",
  descricao:
    "Task 2.4 (28/05): qualquer mov E (recebimento OC, transferência, " +
    "avulso, ajuste) varre pedidos em status_separacao='validacao_oc' " +
    "do mesmo produto+galpão e marca flag_saldo_apareceu=true. Frontend " +
    "mostra banner no checklist pra reconferir.",
  tags: ["recebimento", "validacao_oc", "varredura", "fase2"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("66");
    await ctx.criarProduto({ sku, descricao: "Varredura validacao 66" });
    // Pedido com 0 saldo → aprovação OC entra em validacao_oc
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    // Pós F1 (auto-OC): OC é auto-aprovada pelo webhook, aguarda validacao_oc.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });
    return { sku, pedidoId: pedido.id };
  },

  run: async (ctx: Ctx, { sku, pedidoId }: { sku: string; pedidoId: string }) => {
    // Confere estado inicial: validacao_oc + flag false
    const { data: ped0 } = await ctx.sb
      .from("siso_pedidos")
      .select("status_separacao, flag_saldo_apareceu")
      .eq("id", pedidoId)
      .single();
    if (ped0?.status_separacao !== "validacao_oc") {
      throw new Error(
        `esperava status_separacao=validacao_oc, recebi ${ped0?.status_separacao}`,
      );
    }
    if (ped0?.flag_saldo_apareceu) {
      throw new Error("flag não devia estar true ainda");
    }

    // Recebimento avulso de 5un → dispara varredura
    await ctx.receber({
      items: [{ sku, qty: 5, loc_destino: "A-05-03" }],
      galpao: "CWB",
      entrada_direta: true,
    });

    // Aguarda async (varredura é fire-and-forget) — polling até flag virar true
    let pedRow: { flag_saldo_apareceu?: boolean } | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { data } = await ctx.sb
        .from("siso_pedidos")
        .select("flag_saldo_apareceu")
        .eq("id", pedidoId)
        .single();
      pedRow = data;
      if (pedRow?.flag_saldo_apareceu) break;
      await ctx.aguardar(200);
    }
    if (!pedRow?.flag_saldo_apareceu) {
      throw new Error("flag_saldo_apareceu não foi marcado após recebimento");
    }
  },

  assertEsperado: async (ctx: Ctx, { pedidoId }: { sku: string; pedidoId: string }) => {
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("flag_saldo_apareceu, status_separacao")
      .eq("id", pedidoId)
      .single();
    if (!ped?.flag_saldo_apareceu) {
      throw new Error("flag_saldo_apareceu não persistiu");
    }
    // Status_separacao continua validacao_oc (varredura só marca flag, não transita)
    if (ped.status_separacao !== "validacao_oc") {
      throw new Error(
        `esperava continuar em validacao_oc, recebi ${ped.status_separacao}`,
      );
    }
  },
} satisfies Cenario<{ sku: string; pedidoId: string }>;

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
