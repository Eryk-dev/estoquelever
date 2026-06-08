import type { Cenario, Ctx } from "../_harness/types";

/**
 * Reproduz finding #3.2: /api/wms/compras/comprar marca itens como
 * comprado SEM criar siso_ordens_compra, então compras-release nunca
 * acha a OC e o pedido fica preso.
 *
 * Pré-fix: cenário falha — `/compras/comprar` retorna sem `ordem_id`
 * e os itens ficam sem `ordem_compra_id` vinculado.
 * Pós-fix: cenário passa — `findOrCreateOC` busca/insere a OC e
 * cada item recebe `ordem_compra_id`.
 *
 * NOTA importante sobre o fluxo: na realidade o `validar-oc-item`
 * (acao=esgotado) já tenta criar a OC via `linkItemToOC` antes de
 * chamar `/compras/comprar`. Pra isolar o teste no comportamento do
 * `/compras/comprar` (defense-in-depth), limpamos manualmente
 * `ordem_compra_id` dos itens + dropamos a OC criada pelo validar.
 * Aí `comprar` é a única superfície responsável por garantir a OC.
 */
export default {
  nome: "23 — comprar cria siso_ordens_compra (release não falha)",
  descricao:
    "Marca itens como comprado via /compras/comprar. Deve INSERT em " +
    "siso_ordens_compra e setar ordem_compra_id nos itens — senão compras-release " +
    "nunca encontra a OC e o pedido fica preso.",
  tags: ["compras", "comprar", "ordens-compra"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("23");
    await ctx.criarProduto({ sku, descricao: "Comprar 23" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    // Pós F1 (auto-OC): webhook auto-aprova OC, aguarda diretamente validacao_oc.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // Transição validacao_oc → aguardando_compra via validar-oc-item
    // (acao=esgotado). Isso é o caminho de produção.
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

    // ── Limpa OC criada pelo validar-oc-item pra isolar o teste em
    //    /compras/comprar (defense-in-depth de findOrCreateOC).
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

    const { data: itensPre } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, ordem_compra_id, compra_status")
      .eq("pedido_id", pedido.id);
    if ((itensPre ?? []).some((i) => i.ordem_compra_id)) {
      throw new Error("setup: itens já têm ordem_compra_id antes de comprar — inválido");
    }

    const ordem = await ctx.comprar({ sku, qty: 2 });

    const { data: itensPos } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, ordem_compra_id, compra_status")
      .eq("pedido_id", pedido.id);
    if (!itensPos || itensPos.length === 0) {
      throw new Error(`comprar: itens do pedido ${pedido.id} sumiram após comprar`);
    }
    const todosComOC = itensPos.every(
      (i) => i.ordem_compra_id && i.compra_status === "comprado",
    );
    if (!todosComOC) {
      throw new Error(
        `comprar não vinculou ordem_compra_id: ${JSON.stringify(itensPos)}`,
      );
    }

    if (!ordem.ordem_id) {
      throw new Error("comprar não retornou ordem_id");
    }
    const { data: oc } = await ctx.sb
      .from("siso_ordens_compra")
      .select("id, status")
      .eq("id", ordem.ordem_id)
      .maybeSingle();
    if (!oc) {
      throw new Error("OC retornada pelo /comprar não existe no banco");
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // NOTE: siso_pedido_itens.produto_id armazena o Tiny product ID
    // (bigint) — NÃO o uuid do siso_produtos. Filtro por sku é o
    // caminho correto pra cross-reference.
    const { data: itens } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, pedido_id, ordem_compra_id, compra_status")
      .eq("sku", sku);
    const ocIdsDosItens = [
      ...new Set(
        (itens ?? [])
          .map((i: { ordem_compra_id: string | null }) => i.ordem_compra_id)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    if (ocIdsDosItens.length === 0) {
      throw new Error(
        `Nenhum item ficou com ordem_compra_id após comprar — bug #3.2 (itens=${JSON.stringify(itens)})`,
      );
    }
    const { data: ocs } = await ctx.sb
      .from("siso_ordens_compra")
      .select("id, fornecedor, status")
      .in("id", ocIdsDosItens);
    if ((ocs ?? []).length === 0) {
      throw new Error("Nenhuma OC criada após comprar — bug #3.2");
    }
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
