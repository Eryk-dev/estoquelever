import type { Cenario, Ctx } from "../_harness/types";

interface PedidoLista {
  id: string;
  sugestao: string;
  sugestaoMotivo: string;
  status: string;
}

/**
 * Regressão do bug reportado no pedido #50117 (EasyPeasy/ML/CWB): a listagem
 * de pedidos pendentes continuava servindo a sugestão congelada do webhook —
 * o operador via "Transferência" mesmo depois do estoque chegar no galpão home.
 *
 * Nota: o caso original era OC→Própria, mas após FASE 1 (auto-OC) pedidos OC
 * nunca ficam em `pendente` — são auto-aprovados imediatamente pelo webhook.
 * O invariante da regressão ainda se aplica a pedidos `transferencia`, que
 * continuam parando em `pendente` aguardando aprovação humana.
 *
 * Estratégia: seeda saldo SOMENTE em SP (galpão não-home da NetAir). O
 * roteamento escolhe SP como cobre-100% mas com geoPriority > 0 → `transferencia`,
 * que fica `pendente`. Depois adiciona saldo em CWB (home, geoPriority 0) e
 * verifica que a listagem recomputa para `propria`.
 */
export default {
  nome: "72 — Listagem recalcula sugestão contra estoque vivo (Transferência→Própria)",
  descricao:
    "Pedido cai Transferência (saldo só em SP); saldo chega em CWB depois; " +
    "GET /api/wms/pedidos passa a sugerir Própria porque recomputa contra " +
    "o estoque vivo, não o snapshot congelado no webhook.",
  tags: ["pedido", "sugestao", "transferencia", "estoque-vivo", "listagem", "regressao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("72");
    await ctx.criarProduto({ sku, descricao: "Sugestão viva 72" });
    // Saldo somente em SP (não-home da NetAir → geoPriority > 0 → transferencia).
    // CWB fica sem saldo para forçar roteamento transferencia.
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "A-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    // 1. Webhook: SP cobre 100% mas não é home da NetAir → transferencia → pendente.
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "transferencia" });

    // Sanidade: enquanto CWB não tem saldo, a listagem sugere transferencia.
    const antes = await ctx.http.get<PedidoLista[]>("/api/wms/pedidos?status=pendente");
    const pedidoAntes = antes.find((p) => p.id === pedido.id);
    if (!pedidoAntes) {
      throw new Error(`pedido ${pedido.id} não apareceu na listagem antes do saldo em CWB`);
    }
    if (pedidoAntes.sugestao !== "transferencia") {
      throw new Error(
        `sem saldo em CWB a sugestão deveria ser 'transferencia', veio '${pedidoAntes.sugestao}'`,
      );
    }

    // 2. Estoque chega no galpão home (CWB, preferred da NetAir).
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

    // 3. Com saldo vivo em CWB (home), a LISTAGEM recomputa e sugere Própria.
    const depois = await ctx.http.get<PedidoLista[]>("/api/wms/pedidos?status=pendente");
    const pedidoDepois = depois.find((p) => p.id === pedidoId);
    if (!pedidoDepois) {
      throw new Error(`pedido ${pedidoId} sumiu da listagem após o saldo em CWB chegar`);
    }
    if (pedidoDepois.sugestao !== "propria") {
      throw new Error(
        `com estoque vivo em CWB a sugestão da listagem deveria ser 'propria', ` +
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
