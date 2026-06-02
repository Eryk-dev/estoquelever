import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 81 — Mecanismo 2: receber via OC destrava o pedido
 *
 * Um pedido 100%-OC sem estoque inicial é aprovado, seus itens são marcados
 * como esgotados (status_separacao → aguardando_compra), o comprador registra
 * a compra, e então a OC é recebida via POST /api/wms/receber/oc/[id].
 *
 * Critério de aprovação: após o recebimento, o pedido deve SAIR de
 * "aguardando_compra" (o reconciliador / trigger pós-recebimento o libera).
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  sku: string;
  // Populados durante run (assertEsperado recebe só ctx + setup)
  pedidoId: string;
};

export default {
  nome: "81 — Mecanismo 2: receber via OC destrava o pedido (aguardando_compra → liberado)",
  descricao:
    "Pedido 100%-OC, esgotado → aguardando_compra. Comprador registra compra. " +
    "Recebimento via POST /api/wms/receber/oc/[id] deve liberar o pedido " +
    "(status_separacao != 'aguardando_compra').",
  tags: ["reconciliador", "recebimento", "oc", "destravar", "mecanismo2"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("81");
    await ctx.criarProduto({ sku, descricao: "Receber OC Destrava 81" });
    // Sem saldo inicial — pedido vai para OC obrigatoriamente.
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;

    // ── 1. Disparar webhook: pedido de 4 unidades sem estoque ──
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 4 }],
    });
    setup.pedidoId = id;

    // Sem estoque → OC: fica em status='pendente' (aguardando aprovação humana).
    await ctx.aguardarStatus(id, "pendente", undefined, { timeout_ms: 20000 });

    // ── 2. Aprovar como OC → validacao_oc ──
    await ctx.aprovar(id, "oc");
    await ctx.aguardarStatusSeparacao(id, "validacao_oc");

    // ── 3. Buscar item do pedido para validar-oc-item ──
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", id)
      .single();

    if (!itemRow) {
      throw new Error(`Nenhum item encontrado para pedido ${id}`);
    }
    const itemId = String((itemRow as { id: string | number }).id);

    // ── 4. Marcar item como esgotado → aguardando_compra ──
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [itemId],
      acao: "esgotado",
    });
    await ctx.aguardarStatusSeparacao(id, "aguardando_compra");

    // ── 5. Comprador registra a compra (cria OC e linka item) ──
    await ctx.comprar({ sku, qty: 4, pedido_id: id });

    // ── 6. Resolver a OC vinculada ao item do pedido ──
    const { data: itemComOC } = await ctx.sb
      .from("siso_pedido_itens")
      .select("ordem_compra_id")
      .eq("pedido_id", id)
      .single();

    const ordemCompraId = (itemComOC as { ordem_compra_id: string | null } | null)
      ?.ordem_compra_id;
    if (!ordemCompraId) {
      throw new Error(`Item do pedido ${id} não tem ordem_compra_id após comprar()`);
    }

    // ── 7. Buscar item_id da OC para o POST de recebimento ──
    // O body de POST /api/wms/receber/oc/[id] usa item_id (id de siso_pedido_itens)
    const { data: ocItens } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("ordem_compra_id", ordemCompraId);

    const ocItemId = String(
      ((ocItens ?? [])[0] as { id: string | number } | undefined)?.id ?? itemId,
    );

    // ── 8. Receber via OC → deve destravar o pedido ──
    await ctx.http.post(`/api/wms/receber/oc/${ordemCompraId}`, {
      itens: [
        {
          item_id: ocItemId,
          qty_real: 4,
          custo_unitario: 10,
        },
      ],
    });

    // Aguarda o reconciliador / trigger propagar a mudança de status
    await ctx.aguardar(2000);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pedidoId } = setup;

    if (!pedidoId) {
      throw new Error("pedidoId não foi populado durante run()");
    }

    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("status_separacao")
      .eq("id", pedidoId)
      .single();

    if (!pedido) {
      throw new Error(`Pedido ${pedidoId} não encontrado`);
    }

    if (
      (pedido as { status_separacao: string }).status_separacao === "aguardando_compra"
    ) {
      throw new Error(
        `Mecanismo 2 falhou: pedido ${pedidoId} ainda está em 'aguardando_compra' ` +
          `após recebimento via OC — o reconciliador/trigger não o destravou.`,
      );
    }
  },
} satisfies Cenario<Setup>;

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
