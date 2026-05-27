import type { Cenario, Ctx } from "../_harness/types";

/**
 * Reproduz finding #3.4: cancelar um pedido cujos itens de OC já foram
 * recebidos (`compra_quantidade_recebida > 0`) deixa as movs E (nf_compra)
 * intactas no ledger, gerando "saldo fantasma" no galpão sem dono lógico.
 *
 * Pré-fix: cenário falha — mov S estorno ausente.
 * Pós-fix: cenário passa — `cancelar` itera os itens com qty recebida,
 * estornando cada mov E nf_compra via `estornarMovimentacao` (mov S
 * origem_tipo='estorno', estorno_de=mov_E.id).
 *
 * NOTA importante sobre o fluxo (igual cenário 23): o pedido OC entra
 * em `validacao_oc` ao ser aprovado. Pra chegar em `aguardando_compra`
 * e poder comprar, chamamos `/validar-oc-item` com `acao=esgotado`.
 * O validar-oc-item cria uma OC automaticamente, então limpamos isso
 * antes de chamar `/compras/comprar` (defense-in-depth de findOrCreateOC).
 */
export default {
  nome: "24 — Cancelar pedido com OC recebida estorna saldo no ledger",
  descricao:
    "Pedido OC, comprar, receber. Saldo entra no WMS. Cancelar pedido " +
    "agora deve gerar mov S estorno (origem_tipo='estorno', estorno_de=mov_E) — " +
    "senão saldo fica fantasma no galpão sem dono lógico.",
  tags: ["compras", "cancelar", "estorno", "ledger"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("24");
    await ctx.criarProduto({ sku, descricao: "Cancelar OC 24" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente");
    await ctx.aprovar(pedido.id, "oc");
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc");

    // Transição validacao_oc → aguardando_compra via validar-oc-item
    // (acao=esgotado). Caminho de produção.
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: await (async () => {
        const { data } = await ctx.sb
          .from("siso_pedido_itens")
          .select("id")
          .eq("pedido_id", pedido.id);
        return (data ?? []).map((r: { id: string }) => String(r.id));
      })(),
      acao: "esgotado",
    });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_compra");

    // ── Limpa OC criada pelo validar-oc-item pra isolar o caminho
    //    /compras/comprar -> /compras/receber (mesma técnica do cenário 23).
    const { data: itensComOC } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, ordem_compra_id")
      .eq("pedido_id", pedido.id);
    const ocIdsParaLimpar = [
      ...new Set(
        (itensComOC ?? [])
          .map((i: { ordem_compra_id: string | null }) => i.ordem_compra_id)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    await ctx.sb
      .from("siso_pedido_itens")
      .update({ ordem_compra_id: null })
      .eq("pedido_id", pedido.id);
    if (ocIdsParaLimpar.length > 0) {
      await ctx.sb
        .from("siso_ordens_compra")
        .delete()
        .in("id", ocIdsParaLimpar);
    }

    const ordem = await ctx.comprar({ sku, qty: 3 });
    await ctx.receberCompra({
      ordem_id: ordem.ordem_id,
      items: [{ sku, qty: 3 }],
    });

    // Saldo deve estar +3 antes de cancelar
    const { data: estoqueAntes } = await ctx.sb
      .from("siso_estoque")
      .select("saldo")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id);
    const totalAntes = (estoqueAntes ?? []).reduce(
      (s, e) => s + Number(e.saldo),
      0,
    );
    if (totalAntes < 3) {
      throw new Error(`setup: esperava saldo>=3, recebido ${totalAntes}`);
    }

    // Cancela pedido
    await ctx.http.post(`/api/wms/compras/pedidos/${pedido.id}/cancelar`);
  },

  assertEsperado: async (ctx, { sku }) => {
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id, tipo, origem_tipo, estorno_de, quantidade")
      .eq("produto_id", produto!.id);

    const movE = (movs ?? []).find(
      (m) => m.tipo === "E" && m.origem_tipo === "nf_compra",
    );
    if (!movE) throw new Error("mov E nf_compra ausente");

    const movS = (movs ?? []).find(
      (m) =>
        m.tipo === "S" &&
        m.origem_tipo === "estorno" &&
        m.estorno_de === movE.id,
    );
    if (!movS) {
      throw new Error("mov S estorno ausente — cancelar não estornou (#3.4)");
    }
  },
} satisfies Cenario<{ sku: string }>;

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
