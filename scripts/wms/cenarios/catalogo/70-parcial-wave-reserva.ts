import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 70 — Parcial WAVE multi-pedido (mesmo SKU, 2 pedidos consolidados).
 * Pega 1 de 2 unidades (loc NÃO zerou). Repro do bug: o loop de liberação
 * soltava a R de TODOS os pedidos do wave (100% cada) sem recriar → o pedido
 * que não recebeu unidade perdia a reserva pra sempre (caso #50144/#50189).
 *
 * Esperado pós-parcial consolidado (pega=1, loc_zerou=false):
 *   - 1 saída S de 1 un (saldo 5→4)
 *   - reservado = 1 (só a R do pedido atendido foi liberada; o residual mantém R)
 *   - pedido atendido (FCFS = menor id): quantidade_pega=1, separacao_marcado=true
 *   - pedido residual: quantidade_pega=0/null, separacao_marcado=false, R viva
 * Depois completa o residual (parcial single qty=1 no pedido residual):
 *   - acha a R viva, fecha o item; saldo 4→3, reservado 0
 */
export default {
  nome: "70 — Parcial wave multi-pedido não destrói reserva do residual",
  descricao:
    "2 pedidos mesmo SKU consolidados; pega 1 de 2 loc_zerou=false → só a R do atendido é liberada, residual mantém reserva.",
  tags: ["separacao", "parcial", "wave", "reserva", "regressao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("70");
    await ctx.criarProduto({ sku, descricao: "Parcial wave 70" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-04", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Dois pedidos de 1 un cada (NetAir→CWB, auto-aprova própria).
    const p1 = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }] });
    const p2 = await ctx.webhook({ empresa: ctx.staging.empresas.netair.cnpj, items: [{ sku, qty: 1 }] });
    for (const p of [p1, p2]) {
      await ctx.aguardarStatus(p.id, "concluido");
      await ctx.aguardarStatusSeparacao(p.id, "aguardando_separacao");
      await ctx.iniciarSeparacao(p.id);
    }

    // Reserva inicial: 2 (1 por pedido) na A-01-04.
    await ctx.assertReservado(sku, "CWB", "A-01-04", 2);

    // Resolve os 2 item_ids (mesmo SKU em pedidos diferentes) + galpão p/ header.
    const itemIds = await itemIdsDoSku(ctx, [p1.id, p2.id], sku);
    const galpaoId = await galpaoDoPedido(ctx, p1.id);

    // Parcial CONSOLIDADO: manda os 2 item_ids numa chamada só (= o que o
    // checklist faz no wave). Pega 1, loc NÃO zerou.
    const resp = await ctx.http.post<{ status?: string }>(
      "/api/wms/separacao/parcial",
      { pedido_item_ids: itemIds, quantidade_pega: 1, loc_zerou: false },
      galpaoId ? { "X-Galpao-Id": galpaoId } : {},
    );
    if (resp.status !== "parcial_em_progresso") {
      throw new Error(`esperava status parcial_em_progresso; real=${resp.status}`);
    }

    // ── Asserções do fix ──
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 4); // 1 S de 1
    await ctx.assertReservado(sku, "CWB", "A-01-04", 1); // ← FALHA no código atual (libera as 2 → 0)

    const { atendido, residual } = await classificarItens(ctx, [p1.id, p2.id], sku);
    if (Number(atendido.quantidade_pega) !== 1 || atendido.separacao_marcado !== true) {
      throw new Error(`pedido atendido deveria ter pega=1 e marcado=true; real pega=${atendido.quantidade_pega} marcado=${atendido.separacao_marcado}`);
    }
    if (Number(residual.quantidade_pega ?? 0) !== 0 || residual.separacao_marcado === true) {
      throw new Error(`pedido residual deveria ter pega=0 e marcado=false; real pega=${residual.quantidade_pega} marcado=${residual.separacao_marcado}`);
    }

    // ── Completa o residual (single) — prova que a R viva foi encontrada ──
    await ctx.parcial({ pedido: residual.pedido_id, item: sku, qty: 1, loc_zerou: false });
    return { sku };
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 3); // 5 - 1 - 1
    await ctx.assertReservado(sku, "CWB", "A-01-04", 0); // tudo separado
    await ctx.assertSemReservasOrfas();

    // Estado final: AMBOS os itens separados (pega=1, marcado=true).
    const { data: itensFinais } = await ctx.sb
      .from("siso_pedido_itens")
      .select("quantidade_pega, separacao_marcado, sku")
      .eq("sku", sku);
    const rows = (itensFinais ?? []) as Array<{ quantidade_pega: number | null; separacao_marcado: boolean | null }>;
    if (rows.length !== 2) throw new Error(`esperava 2 itens do sku ${sku}; achei ${rows.length}`);
    for (const r of rows) {
      if (Number(r.quantidade_pega ?? 0) !== 1 || r.separacao_marcado !== true) {
        throw new Error(`item final deveria ter pega=1 e marcado=true; real pega=${r.quantidade_pega} marcado=${r.separacao_marcado}`);
      }
    }
  },
} satisfies Cenario<{ sku: string }>;

type ItemRow = {
  id: string | number;
  pedido_id: string;
  quantidade_pega: number | null;
  separacao_marcado: boolean | null;
};

async function itemIdsDoSku(ctx: Ctx, pedidoIds: string[], sku: string): Promise<(string | number)[]> {
  const { data } = await ctx.sb
    .from("siso_pedido_itens")
    .select("id, pedido_id, sku")
    .in("pedido_id", pedidoIds)
    .eq("sku", sku);
  const ids = (data ?? []).map((r) => (r as { id: string | number }).id);
  if (ids.length !== pedidoIds.length) throw new Error(`esperava ${pedidoIds.length} itens do sku ${sku}; achei ${ids.length}`);
  return ids;
}

async function galpaoDoPedido(ctx: Ctx, pedidoId: string): Promise<string | undefined> {
  const { data } = await ctx.sb
    .from("siso_pedidos")
    .select("separacao_galpao_id")
    .eq("id", pedidoId)
    .maybeSingle();
  return (data as { separacao_galpao_id?: string } | null)?.separacao_galpao_id;
}

async function classificarItens(ctx: Ctx, pedidoIds: string[], sku: string): Promise<{ atendido: ItemRow; residual: ItemRow }> {
  const { data } = await ctx.sb
    .from("siso_pedido_itens")
    .select("id, pedido_id, quantidade_pega, separacao_marcado, sku")
    .in("pedido_id", pedidoIds)
    .eq("sku", sku);
  const rows = (data ?? []) as ItemRow[];
  const atendido = rows.find((r) => Number(r.quantidade_pega ?? 0) > 0);
  const residual = rows.find((r) => Number(r.quantidade_pega ?? 0) === 0);
  if (!atendido || !residual) throw new Error(`não classifiquei itens: ${JSON.stringify(rows)}`);
  return { atendido, residual };
}

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
