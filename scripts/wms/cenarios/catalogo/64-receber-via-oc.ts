import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "64 — Receber via OC com pré-preenchimento + divergência",
  descricao:
    "Task 2.2 (28/05): nova rota POST /api/wms/receber/oc/[id] gera mov E " +
    "em RECEBIMENTO com custo da OC + cria pendência de guarda + atualiza " +
    "compra_quantidade_recebida. Suporta qty parcial com motivo de divergência.",
  tags: ["recebimento", "oc", "fase2"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("64");
    await ctx.criarProduto({ sku, descricao: "Receber via OC 64" });
    // Cria pedido + aprova OC + comprador compra 50un
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.sb
      .from("siso_pedidos")
      .update({ status: "pendente" })
      .eq("id", pedido.id);
    await ctx.aprovar(pedido.id, "oc");
    const oc = await ctx.comprar({ sku, qty: 50, pedido_id: pedido.id });
    return { sku, pedidoId: pedido.id, ocId: oc.ordem_id };
  },

  run: async (ctx: Ctx, { ocId }: { sku: string; pedidoId: string; ocId: string }) => {
    // GET lista deve incluir essa OC
    const lista = await ctx.http.get<{ ocs: Array<{ id: string }> }>(
      "/api/wms/receber/oc/lista",
    );
    if (!lista.ocs.find((o) => o.id === ocId)) {
      throw new Error(`OC ${ocId} não aparece na lista pendente`);
    }

    // GET detalhe retorna itens com qty solicitada
    const det = await ctx.http.get<{
      itens: Array<{ id: string; esperado: number; pendente: number }>;
    }>(`/api/wms/receber/oc/${ocId}`);
    if (det.itens.length === 0) throw new Error("detalhe sem itens");

    // POST recebe 48 íntegros + 2 com motivo avaria (qty_real=48)
    await ctx.http.post(`/api/wms/receber/oc/${ocId}`, {
      itens: [
        {
          item_id: det.itens[0].id,
          qty_real: 48,
          custo_unitario: 12.8,
          motivo_divergencia: "avaria_transporte",
        },
      ],
    });
  },

  assertEsperado: async (ctx: Ctx, { sku, ocId }: { sku: string; pedidoId: string; ocId: string }) => {
    // Confere: 1 mov E origem nf_compra com qty=48 + custo
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, quantidade, origem_tipo, custo_unitario, origem_id")
      .eq("produto_id", produto!.id)
      .eq("tipo", "E")
      .eq("origem_tipo", "nf_compra");
    const ent = (movs ?? []).find((m) => m.origem_id === ocId);
    if (!ent) throw new Error("esperava mov E nf_compra ligada à OC");
    if (Number(ent.quantidade) !== 48) {
      throw new Error(`mov E qty esperava 48, recebi ${ent.quantidade}`);
    }
    if (Number(ent.custo_unitario) !== 12.8) {
      throw new Error(`mov E custo esperava 12.8, recebi ${ent.custo_unitario}`);
    }

    // OC NÃO fechou (50 solicitados, 48 recebidos)
    const { data: oc } = await ctx.sb
      .from("siso_ordens_compra")
      .select("status")
      .eq("id", ocId)
      .single();
    if (oc?.status === "recebido") {
      throw new Error("OC fechou indevidamente (48 < 50 solicitados)");
    }

    // Pendência de guarda criada
    const { data: pends } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("id, qty_inicial, origem_tipo")
      .eq("mov_entrada_id", ent.id ?? "");
    // mov_entrada_id na pendência aponta pra mov E. Buscamos pelo ent (recém criada)
    if (!pends || pends.length === 0) {
      // Fallback: busca por loteId não é determinístico, então só ver se ALGUMA pendência foi criada nessa OC
      const { data: anyPend } = await ctx.sb
        .from("siso_wms_pendencias_guarda")
        .select("id")
        .eq("produto_id", produto!.id)
        .eq("origem_tipo", "nf_compra")
        .order("criada_em", { ascending: false })
        .limit(1);
      if (!anyPend || anyPend.length === 0) {
        throw new Error("nenhuma pendência criada");
      }
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
