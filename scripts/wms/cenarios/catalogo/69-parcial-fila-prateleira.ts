import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 69 (Fase 3 #3) — Parcial na separação com prateleira ainda com saldo
 * → pedido volta pro FIM da fila; depois o operador RETOMA e completa o residual.
 *
 * Semeia CWB A-01-03 com 10. Pedido de 5 (NetAir→CWB), auto-aprovado própria.
 * Operador inicia e faz Parcial qty=3 loc_zerou=FALSE (pegou 3, prateleira tem 7).
 * Esperado pós-parcial:
 *   - pedido volta pra aguardando_separacao com separacao_reenfileirado_em setado
 *   - item: quantidade_pega=3 (preservada), separacao_marcado=false
 *   - item NÃO fica separacao_parcial=true (senão marcar-item/parcial/bipar
 *     rejeitariam o re-pick e o residual ficaria impossível de completar)
 *   - saldo CWB cai 10→7 (S de 3); a R foi totalmente liberada (não fica reservada)
 * Depois o operador retoma (iniciar) e completa o residual via marcar-item:
 *   - pedido → separado, quantidade_pega=5, saldo CWB 7→5 (S de 2)
 *   - net: 2 saídas S (3 + 2 = 5 = pedido); SEM dupla-baixa (saldo final = 5)
 */
export default {
  nome: "69 — Parcial (prateleira tem) volta pro fim da fila + retoma e completa",
  descricao:
    "Parcial qty<pedido + loc_zerou=false → reenfileira (quantidade_pega preservada, item re-pickável); depois completa o residual sem dupla-baixa.",
  tags: ["separacao", "parcial", "fila", "p3-fase3"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("69");
    await ctx.criarProduto({ sku, descricao: "Parcial fila 69" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-03", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    // CWB cobre 100% (10>=5) → auto-aprova própria; worker conclui; chega em separação.
    await ctx.aguardarStatus(pedido.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
    await ctx.iniciarSeparacao(pedido.id);
    // Parcial: pegou 3 de 5, NÃO zerou a loc (prateleira ainda tem 7).
    await ctx.parcial({ pedido: pedido.id, item: sku, qty: 3, loc_zerou: false });

    // ── Asserções intermediárias: estado pós-reenfileiramento ──
    const itemMid = await carregarItem(ctx, sku, pedido.id);
    if (Number(itemMid.quantidade_pega) !== 3) {
      throw new Error(`pós-parcial: quantidade_pega deve ser 3; real=${itemMid.quantidade_pega}`);
    }
    if (itemMid.separacao_marcado === true) {
      throw new Error("pós-parcial: separacao_marcado deve ser false (item segue pickável)");
    }
    if (itemMid.separacao_parcial === true) {
      throw new Error(
        "pós-parcial: separacao_parcial deve ser FALSE (true travaria o re-pick — marcar-item/parcial/bipar rejeitam)",
      );
    }
    const pedMid = await carregarPedido(ctx, pedido.id);
    if (pedMid.status_separacao !== "aguardando_separacao") {
      throw new Error(`pós-parcial: status deve ser aguardando_separacao; real=${pedMid.status_separacao}`);
    }
    if (!pedMid.separacao_reenfileirado_em) {
      throw new Error("pós-parcial: separacao_reenfileirado_em deve estar setado (fim da fila)");
    }
    await ctx.assertSaldo(sku, "CWB", "A-01-03", 7);

    // ── Operador RETOMA e completa o residual (path que o dead-end quebrava) ──
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 2 }); // marcar-item desconta 5-3=2
    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado");

    return { pedidoId: pedido.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    const item = await carregarItem(ctx, sku);
    if (Number(item.quantidade_pega) !== 5) {
      throw new Error(`final: quantidade_pega deve ser 5 (completo); real=${item.quantidade_pega}`);
    }
    if (item.separacao_marcado !== true) {
      throw new Error("final: separacao_marcado deve ser true (concluído)");
    }
    // Net: 10 - 3 (parcial) - 2 (completar) = 5. saldo<5 indicaria dupla-baixa.
    await ctx.assertSaldo(sku, "CWB", "A-01-03", 5);
  },
} satisfies Cenario<{ sku: string }>;

type ItemRow = {
  pedido_id: string;
  quantidade_pega: number | null;
  separacao_parcial: boolean | null;
  separacao_marcado: boolean | null;
};
type PedidoRow = { status_separacao: string; separacao_reenfileirado_em: string | null };

async function carregarItem(ctx: Ctx, sku: string, pedidoId?: string): Promise<ItemRow> {
  let q = ctx.sb
    .from("siso_pedido_itens")
    .select("pedido_id, quantidade_pega, separacao_parcial, separacao_marcado")
    .eq("sku", sku);
  if (pedidoId) q = q.eq("pedido_id", pedidoId);
  const { data } = await q;
  const row = (data ?? [])[0] as ItemRow | undefined;
  if (!row) throw new Error(`item do pedido 69 (sku ${sku}) não encontrado`);
  return row;
}

async function carregarPedido(ctx: Ctx, pedidoId: string): Promise<PedidoRow> {
  const { data } = await ctx.sb
    .from("siso_pedidos")
    .select("status_separacao, separacao_reenfileirado_em")
    .eq("id", pedidoId)
    .single();
  return data as PedidoRow;
}

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
