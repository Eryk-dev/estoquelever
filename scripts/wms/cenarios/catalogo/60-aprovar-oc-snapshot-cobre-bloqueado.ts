import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "60 — Aprovar OC com snapshot completo é bloqueado",
  descricao:
    "Decisão 1 (28/05): aprovação como OC retorna 422 oc_bloqueado_snapshot_cobre " +
    "quando o snapshot do pedido cobre 100% dos itens na empresa origem. " +
    "Evita degradação silenciosa pra Própria sem reserva no worker.",
  tags: ["pedido", "aprovar", "oc", "snapshot", "fase1"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("60");
    await ctx.criarProduto({ sku, descricao: "Aprovar OC bloqueado 60" });
    // Saldo suficiente em CWB (galpão preferred da NetAir)
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    // Webhook com saldo suficiente auto-aprova como propria — força pendente
    // marcando pedido como pendente manualmente (cenário precisa testar a aprovação OC explícita).
    await ctx.sb
      .from("siso_pedidos")
      .update({ status: "pendente", decisao_final: null, status_separacao: null })
      .eq("id", pedido.id);

    let erro: Error | null = null;
    try {
      await ctx.aprovar(pedido.id, "oc");
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error("aprovar OC deveria ter falhado com 422 mas não falhou");
    }
    if (!/422|oc_bloqueado_snapshot_cobre/i.test(erro.message)) {
      throw new Error(
        `aprovar OC falhou mas mensagem inesperada: ${erro.message}`,
      );
    }
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string }) => {
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .maybeSingle();
    if (itemRow?.pedido_id) {
      // Pedido segue pendente — aprovação OC foi rejeitada
      await ctx.assertPedidoStatus(String(itemRow.pedido_id), "pendente");
    }
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
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
