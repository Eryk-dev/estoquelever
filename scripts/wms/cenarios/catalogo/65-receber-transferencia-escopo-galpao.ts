import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "65 — Lista de transferências respeita escopo do galpão (Decisão 10)",
  descricao:
    "Task 2.3 (28/05): GET /api/wms/receber/transferencia/lista filtra " +
    "transferências em_transito por destino = galpão do operador. Admin " +
    "vê todas; operador-galpão vê só as suas.",
  tags: ["recebimento", "transferencia", "escopo", "fase2"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("65");
    await ctx.criarProduto({ sku, descricao: "Transfer escopo 65" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 30 });
    const tr = await ctx.criarTransferenciaHeader({
      origem: "CWB",
      destino: "SP",
      items: [{ sku, loc_origem: "A-01-01", qty: 5 }],
    });
    return { transferenciaId: tr.id };
  },

  run: async (ctx: Ctx, { transferenciaId }: { transferenciaId: string }) => {
    // GET lista (como test-runner = admin) → vê a transferência
    const lista = await ctx.http.get<{
      transferencias: Array<{ id: string; destino_nome: string }>;
    }>("/api/wms/receber/transferencia/lista");
    if (!lista.transferencias.find((t) => t.id === transferenciaId)) {
      throw new Error(`transferência ${transferenciaId} não aparece na lista`);
    }
    // Confere que destino_nome = SP
    const t = lista.transferencias.find((x) => x.id === transferenciaId)!;
    if (t.destino_nome !== "SP") {
      throw new Error(`destino esperava SP, recebi ${t.destino_nome}`);
    }

    // GET detalhe retorna itens pendentes
    const det = await ctx.http.get<{
      transferencia: {
        id: string;
        galpao_destino_id: string;
        itens: Array<{ id: string; qty: number; mov_entrada_id: string | null }>;
      };
    }>(`/api/wms/receber/transferencia/${transferenciaId}`);
    if (det.transferencia.itens.length !== 1) {
      throw new Error(`esperava 1 item, recebi ${det.transferencia.itens.length}`);
    }
    if (det.transferencia.itens[0].mov_entrada_id) {
      throw new Error("item já recebido — devia estar pendente");
    }
  },

  assertEsperado: async (ctx: Ctx, { transferenciaId }: { transferenciaId: string }) => {
    // Header continua em_transito (não recebemos)
    const { data: tr } = await ctx.sb
      .from("siso_transferencias_galpao")
      .select("status")
      .eq("id", transferenciaId)
      .single();
    if (tr?.status !== "em_transito") {
      throw new Error(`esperava em_transito, recebi ${tr?.status}`);
    }
  },
} satisfies Cenario<{ transferenciaId: string }>;

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
