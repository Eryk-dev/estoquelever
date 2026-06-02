import type { Cenario, Ctx } from "../_harness/types";

interface PedidoLista {
  id: string;
  sugestao: string;
  sugestaoMotivo: string;
  status: string;
}

/**
 * Regressão do bug reportado no pedido #50117 (EasyPeasy/ML/CWB): o pedido caiu
 * como OC porque no momento do webhook não havia saldo, mas depois o estoque
 * chegou e a LISTAGEM continuava sugerindo "Comprar" (OC) — servindo o snapshot
 * congelado de siso_pedidos.sugestao. O operador não pode pedir OC quando há
 * estoque; a sugestão tem de ser Própria.
 *
 * O detalhe (/pedidos/[id]/detalhe) já recomputava ao vivo; a listagem não.
 * Este cenário trava a divergência: GET /api/wms/pedidos deve recomputar a
 * sugestão contra o estoque VIVO pra pedidos ainda em decisão.
 */
export default {
  nome: "72 — Listagem recalcula sugestão contra estoque vivo (OC→Própria)",
  descricao:
    "Pedido cai OC sem saldo; estoque chega depois; GET /api/wms/pedidos passa a " +
    "sugerir Própria (não mais OC) porque a sugestão da listagem é recomputada " +
    "viva, não o snapshot congelado no webhook.",
  tags: ["pedido", "sugestao", "oc", "estoque-vivo", "listagem", "regressao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("72");
    await ctx.criarProduto({ sku, descricao: "Sugestão viva 72" });
    // Sem semearSaldo no setup — saldo zero em todo lugar → pedido cai OC.
    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    // 1. Webhook sem saldo → pendente com sugestão OC (snapshot congelado).
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "oc" });

    // Sanidade: enquanto não há saldo, a listagem também sugere OC.
    const antes = await ctx.http.get<PedidoLista[]>("/api/wms/pedidos?status=pendente");
    const pedidoAntes = antes.find((p) => p.id === pedido.id);
    if (!pedidoAntes) {
      throw new Error(`pedido ${pedido.id} não apareceu na listagem antes do saldo`);
    }
    if (pedidoAntes.sugestao !== "oc") {
      throw new Error(
        `sem saldo a sugestão deveria ser 'oc', veio '${pedidoAntes.sugestao}'`,
      );
    }

    // 2. Estoque chega no galpão casa (CWB, preferred da NetAir).
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5 });
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string }) => {
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .maybeSingle();
    const pedidoId = itemRow?.pedido_id ? String(itemRow.pedido_id) : null;
    if (!pedidoId) throw new Error("pedido do cenário 72 não encontrado");

    // 3. Com saldo vivo cobrindo, a LISTAGEM recomputa e sugere Própria — não OC.
    const depois = await ctx.http.get<PedidoLista[]>("/api/wms/pedidos?status=pendente");
    const pedidoDepois = depois.find((p) => p.id === pedidoId);
    if (!pedidoDepois) {
      throw new Error(`pedido ${pedidoId} sumiu da listagem após o saldo chegar`);
    }
    if (pedidoDepois.sugestao !== "propria") {
      throw new Error(
        `com estoque vivo a sugestão da listagem deveria ser 'propria', ` +
          `veio '${pedidoDepois.sugestao}' (motivo: ${pedidoDepois.sugestaoMotivo})`,
      );
    }

    // Pedido segue pendente — recompute é só de exibição, não decide nada.
    await ctx.assertPedidoStatus(pedidoId, "pendente");
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
