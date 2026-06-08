import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 30 — Audit trail de compras (comprar + receber).
 *
 * Garante que os endpoints /api/wms/compras/comprar e /api/wms/compras/receber
 * registram eventos `compra_item_comprado` e `compra_item_recebido` em
 * siso_pedido_historico com o JSON `detalhes` esperado (qty_total + skus).
 *
 * Fluxo: pedido sem saldo → vira OC → aprovar → validar-oc-item (acao=esgotado,
 * via ctx.comprar) → /compras/comprar → /compras/receber → assert nas linhas
 * de pedido_historico.
 */
export default {
  nome: "30 — compras/comprar + receber registram audit trail em pedido_historico",
  descricao:
    "Cria pedido OC, executa fluxo comprar+receber e valida que " +
    "siso_pedido_historico recebe `compra_item_comprado` e `compra_item_recebido` " +
    "com detalhes.skus contendo o SKU do pedido.",
  tags: ["compras", "audit", "historico", "comprar", "receber"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("30");
    await ctx.criarProduto({ sku, descricao: "Item audit compras 30" });
    // Sem saldo — pedido vai pra OC.
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    // Pós F1 (auto-OC): webhook auto-aprova OC, aguarda diretamente validacao_oc.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // /validar-oc-item (esgotado) + /compras/comprar.
    await ctx.comprar({ sku, qty: 2, pedido_id: pedido.id });

    // /compras/receber.
    await ctx.receberCompra({ ordem_id: "ignored", items: [{ sku, qty: 2 }] });

    (ctx as unknown as { _cenario30_pedido_id?: string })._cenario30_pedido_id =
      pedido.id;
    (ctx as unknown as { _cenario30_sku?: string })._cenario30_sku = sku;
  },

  assertEsperado: async (ctx) => {
    const pedidoId = (ctx as unknown as { _cenario30_pedido_id?: string })
      ._cenario30_pedido_id;
    const sku = (ctx as unknown as { _cenario30_sku?: string })._cenario30_sku;
    if (!pedidoId || !sku) throw new Error("pedido_id/sku não capturados");

    const { data: eventos, error } = await ctx.sb
      .from("siso_pedido_historico")
      .select("evento, detalhes")
      .eq("pedido_id", pedidoId)
      .in("evento", ["compra_item_comprado", "compra_item_recebido"]);

    if (error) throw new Error(`select historico: ${error.message}`);
    if (!eventos || eventos.length === 0) {
      throw new Error(
        "nenhum evento compra_item_comprado/recebido em siso_pedido_historico",
      );
    }

    const compradoEvt = eventos.find(
      (e) => (e as { evento: string }).evento === "compra_item_comprado",
    ) as { evento: string; detalhes: { qty_total?: number; skus?: string[] } } | undefined;
    if (!compradoEvt) {
      throw new Error("evento compra_item_comprado ausente");
    }
    if (!compradoEvt.detalhes?.skus?.includes(sku)) {
      throw new Error(
        `compra_item_comprado detalhes.skus deveria conter "${sku}"; got ${JSON.stringify(compradoEvt.detalhes)}`,
      );
    }
    if ((compradoEvt.detalhes.qty_total ?? 0) !== 2) {
      throw new Error(
        `compra_item_comprado detalhes.qty_total esperado=2, recebido=${compradoEvt.detalhes.qty_total}`,
      );
    }

    const recebidoEvt = eventos.find(
      (e) => (e as { evento: string }).evento === "compra_item_recebido",
    ) as { evento: string; detalhes: { qty_total?: number; skus?: string[] } } | undefined;
    if (!recebidoEvt) {
      throw new Error("evento compra_item_recebido ausente");
    }
    if (!recebidoEvt.detalhes?.skus?.includes(sku)) {
      throw new Error(
        `compra_item_recebido detalhes.skus deveria conter "${sku}"; got ${JSON.stringify(recebidoEvt.detalhes)}`,
      );
    }
    if ((recebidoEvt.detalhes.qty_total ?? 0) !== 2) {
      throw new Error(
        `compra_item_recebido detalhes.qty_total esperado=2, recebido=${recebidoEvt.detalhes.qty_total}`,
      );
    }
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
