import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "68 — Confirmar guarda em PACKING vira pedido Separado",
  descricao:
    "Task 3.5 (28/05): trigger pós-guarda. Pendência cross-dock guardada " +
    "em loc tipo='packing' dispara prepararPedidosDasOcs nos pedidos " +
    "vinculados que têm 100% dos itens OC recebidos. Saldo continua na " +
    "PACKING aguardando packing+expedição.",
  tags: ["recebimento", "crossdock", "trigger", "packing", "fase3"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("68");
    await ctx.criarProduto({ sku, descricao: "Trigger packing 68" });
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    await ctx.sb
      .from("siso_pedidos")
      .update({ status: "pendente" })
      .eq("id", pedido.id);
    await ctx.aprovar(pedido.id, "oc");
    const oc = await ctx.comprar({ sku, qty: 5, pedido_id: pedido.id });
    return { sku, pedidoId: pedido.id, ocId: oc.ordem_id };
  },

  run: async (ctx: Ctx, { ocId, pedidoId }: { sku: string; pedidoId: string; ocId: string }) => {
    const det = await ctx.http.get<{
      itens: Array<{ id: string; pendente: number }>;
    }>(`/api/wms/receber/oc/${ocId}`);
    await ctx.http.post(`/api/wms/receber/oc/${ocId}`, {
      itens: [
        {
          item_id: det.itens[0].id,
          qty_real: 5,
          custo_unitario: 10,
        },
      ],
    });

    // Busca pendência cross-dock criada
    const { data: pends } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("id, prioridade, destino_sugerido_id, galpao_id")
      .eq("origem_tipo", "nf_compra")
      .order("criada_em", { ascending: false })
      .limit(2);

    const cross = (pends ?? []).find((p) => p.prioridade === "cross_dock");
    if (!cross || !cross.destino_sugerido_id) {
      throw new Error("pendência cross-dock não criada com destino sugerido");
    }

    // Confirma guarda em PACKING (destino sugerido)
    await ctx.http.post(`/api/wms/guarda/${cross.id}/confirmar`, {
      qty: 5,
      localizacao_destino_id: cross.destino_sugerido_id,
    });

    // Aguarda trigger async — pedido deve virar separado
    void pedidoId;
  },

  assertEsperado: async (ctx: Ctx, { pedidoId }: { sku: string; pedidoId: string; ocId: string }) => {
    // Trigger pode levar 1-2s (async no endpoint). Polling até virar separado
    let pedRow: { status_separacao?: string | null } | null = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const { data } = await ctx.sb
        .from("siso_pedidos")
        .select("status_separacao")
        .eq("id", pedidoId)
        .single();
      pedRow = data;
      if (pedRow?.status_separacao === "separado") break;
      await ctx.aguardar(250);
    }
    if (pedRow?.status_separacao !== "separado") {
      throw new Error(
        `esperava status_separacao=separado após trigger PACKING, recebi ${pedRow?.status_separacao}`,
      );
    }
  },
} satisfies Cenario<{ sku: string; pedidoId: string; ocId: string }>;

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
