import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "67 — Recebimento OC com demanda cria 2 pendências (cross-dock)",
  descricao:
    "Task 3.3 (28/05): detectarCrossDock detecta demanda viva pra esse SKU+OC " +
    "e splita pendência em 2 quando recebido cobre demanda parcial. Pendência " +
    "cross-dock leva destino_sugerido_id=PACKING-{galpao} + pedidos_vinculados, " +
    "pendência normal leva o resto.",
  tags: ["recebimento", "crossdock", "pendencia", "fase3"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("67");
    await ctx.criarProduto({ sku, descricao: "Crossdock split 67" });
    // Cria 3 pedidos com demanda 5+7+6 = 18un
    const pedIds: string[] = [];
    for (const qty of [5, 7, 6]) {
      const p = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty }],
      });
      await ctx.sb
        .from("siso_pedidos")
        .update({ status: "pendente" })
        .eq("id", p.id);
      await ctx.aprovar(p.id, "oc");
      pedIds.push(p.id);
    }
    // Comprador compra 50un (1 OC consolidada via /compras/comprar)
    const oc = await ctx.comprar({ sku, qty: 50, pedido_id: pedIds[0] });
    return { sku, pedIds, ocId: oc.ordem_id };
  },

  run: async (ctx: Ctx, { ocId }: { sku: string; pedIds: string[]; ocId: string }) => {
    // GET detalhe da OC
    const det = await ctx.http.get<{
      itens: Array<{ id: string; pendente: number }>;
    }>(`/api/wms/receber/oc/${ocId}`);

    // POST recebe 50un (cobre toda a demanda 18 + sobra 32)
    await ctx.http.post(`/api/wms/receber/oc/${ocId}`, {
      itens: det.itens.map((it) => ({
        item_id: it.id,
        qty_real: 50,
        custo_unitario: 10,
      })),
    });
  },

  assertEsperado: async (ctx: Ctx, { sku, ocId }: { sku: string; pedIds: string[]; ocId: string }) => {
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();

    // Busca pendências geradas via mov_entrada_id da OC
    const { data: movsOC } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("produto_id", produto!.id)
      .eq("tipo", "E")
      .eq("origem_tipo", "nf_compra")
      .eq("origem_id", ocId);
    const movIds = (movsOC ?? []).map((m) => m.id);
    if (movIds.length === 0) {
      throw new Error("nenhuma mov E ligada à OC");
    }

    const { data: pendencias } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select(
        "id, qty_inicial, prioridade, pedidos_vinculados, destino_sugerido_id",
      )
      .in("mov_entrada_id", movIds);

    if (!pendencias || pendencias.length !== 2) {
      throw new Error(
        `esperava 2 pendências (1 cross + 1 normal), recebi ${pendencias?.length ?? 0}`,
      );
    }
    const cross = pendencias.find((p) => p.prioridade === "cross_dock");
    const normal = pendencias.find((p) => p.prioridade === "normal");
    if (!cross) throw new Error("pendência cross_dock não encontrada");
    if (!normal) throw new Error("pendência normal não encontrada");
    if (Number(cross.qty_inicial) !== 18) {
      throw new Error(`cross qty esperava 18, recebi ${cross.qty_inicial}`);
    }
    if (Number(normal.qty_inicial) !== 32) {
      throw new Error(`normal qty esperava 32, recebi ${normal.qty_inicial}`);
    }
    if (!cross.pedidos_vinculados || cross.pedidos_vinculados.length !== 3) {
      throw new Error(
        `cross pedidos_vinculados esperava 3, recebi ${cross.pedidos_vinculados?.length ?? 0}`,
      );
    }
    if (!cross.destino_sugerido_id) {
      throw new Error("cross sem destino_sugerido_id (PACKING-CWB)");
    }
  },
} satisfies Cenario<{ sku: string; pedIds: string[]; ocId: string }>;

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
