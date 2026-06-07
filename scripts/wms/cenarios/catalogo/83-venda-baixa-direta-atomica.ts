import type { Cenario, Ctx } from "../_harness/types";

interface Setup {
  sku: string;
  prodId: string;
  galpaoId: string;
  locA: string;
  locB: string;
  esperadoA: number;
  esperadoB: number;
  pedidoId: string;
}

export default {
  nome: "83 — Venda baixa_direta atômica (RPC)",
  descricao:
    "Venda baixa_direta com saldo split em 2 locs → baixa via RPC wms_vender_baixa_direta_atomico (marker distintivo), pedido não-deletado, sem estorno órfão no caminho feliz.",
  tags: ["vendas", "baixa_direta", "atomicidade"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("83");
    // criarProduto retorna o SKU (não o uuid) — resolve o uuid pra filtrar estoque/movs.
    await ctx.criarProduto({ sku, descricao: "Venda baixa_direta atômica 83" });
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const prodId = prod!.id as string;
    // saldo split assimétrico (6+4) pra split determinístico: qty=8 baixa locA(6→0)+locB(2 restante).
    // sugestoes ordenadas por disponivel desc → locA(A-01-01) primeiro.
    const galpaoId = ctx.staging.galpoes.cwb.id;
    const locA = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-01-01" });
    const locB = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-01-02" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 6 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 4 });
    return { sku, prodId, galpaoId, locA, locB, esperadoA: 0, esperadoB: 2, pedidoId: "" };
  },

  run: async (ctx, setup) => {
    const r = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku: setup.sku, qty: 8 }],
      modo: "baixa_direta",
    });
    if (r.degradado) throw new Error(`venda inesperadamente degradada: ${r.motivo_degradacao}`);
    if (!r.pedido_id) throw new Error("venda não retornou pedido_id");
    setup.pedidoId = r.pedido_id;
  },

  assertEsperado: async (ctx, setup) => {
    // (a) saldo baixou nas 2 locs
    const { data: ests } = await ctx.sb.from("siso_estoque").select("localizacao_id, saldo")
      .eq("produto_id", setup.prodId).eq("galpao_id", setup.galpaoId)
      .in("localizacao_id", [setup.locA, setup.locB]);
    const byLoc = Object.fromEntries((ests ?? []).map((e: any) => [e.localizacao_id, Number(e.saldo)]));
    if (byLoc[setup.locA] !== setup.esperadoA) throw new Error(`saldo locA ${byLoc[setup.locA]} != ${setup.esperadoA}`);
    if (byLoc[setup.locB] !== setup.esperadoB) throw new Error(`saldo locB ${byLoc[setup.locB]} != ${setup.esperadoB}`);
    // (b) RED DISTINTIVO: toda S da venda carrega o marker que SÓ a RPC grava.
    //     O loop JS antigo NÃO seta 'baixa_direta_rpc' → este assert falha contra ele.
    const { data: movsS } = await ctx.sb.from("siso_movimentacoes")
      .select("origem_detalhes")
      .eq("tipo", "S").eq("origem_tipo", "venda_manual")
      .filter("origem_detalhes->>pedido_id_manual", "eq", setup.pedidoId);
    if (!movsS || movsS.length < 2) throw new Error(`esperava >=2 S da venda, achou ${movsS?.length ?? 0}`);
    for (const m of movsS as any[]) {
      if (m.origem_detalhes?.baixa_direta_rpc !== true) {
        throw new Error("S sem marker baixa_direta_rpc — não passou pela RPC (loop JS antigo)");
      }
    }
    // (c) o pedido MAN-... existe (não foi deletado pelo rollback best-effort)
    const { data: ped } = await ctx.sb.from("siso_pedidos").select("id, status")
      .eq("id", setup.pedidoId).maybeSingle();
    if (!ped) throw new Error("pedido foi deletado (rollback best-effort do caminho antigo)");
    // (d) nenhum estorno-E órfão (a RPC não estorna no caminho feliz)
    const { data: estornos } = await ctx.sb.from("siso_movimentacoes")
      .select("id").eq("tipo", "E").eq("origem_tipo", "estorno").eq("pedido_id", setup.pedidoId);
    if ((estornos ?? []).length !== 0) throw new Error("estorno-E órfão no caminho feliz");
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
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
