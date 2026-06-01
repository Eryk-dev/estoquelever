import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "71 — Encontrei com contagem inline acerta a prateleira",
  descricao:
    "Item OC, sistema achava 0 na loc. Operador conta 8 (pedido pede 5). " +
    "Sistema gera Entrada inventario_ganho (+8), separa 5 (Saída nf_venda), " +
    "sobram 3 reais na loc. Contagem oficial: contagens + divergência aplicada " +
    "+ última contagem + acuracidade do operador.",
  tags: ["separacao", "validar-oc", "encontrei", "contagem-inline", "fase1"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("71");
    await ctx.criarProduto({ sku, descricao: "Contagem inline 71" });
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-06-01" });
    return { sku, locId };
  },

  run: async (ctx: Ctx, { sku, locId }: { sku: string; locId: string }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    await ctx.sb.from("siso_pedidos").update({ status: "pendente" }).eq("id", pedido.id);
    await ctx.aprovar(pedido.id, "oc");

    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, produto_id")
      .eq("pedido_id", pedido.id)
      .eq("sku", sku)
      .single();

    // Operador conta 8 e confirma → validar-oc-item com qty_contada + loc REAL
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [String(itemRow!.id)],
      acao: "encontrei",
      localizacao_id: locId,
      qty_contada: 8,
    });
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string; locId: string }) => {
    await ctx.assertSaldo(sku, "CWB", "A-06-01", 3);

    const { data: produto } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, quantidade, origem_tipo")
      .eq("produto_id", produto!.id);
    const ganho = (movs ?? []).find((m) => m.tipo === "E" && m.origem_tipo === "inventario_ganho");
    const saida = (movs ?? []).find((m) => m.tipo === "S" && m.origem_tipo === "nf_venda");
    if (!ganho || Number(ganho.quantidade) !== 8) throw new Error(`esperava E inventario_ganho qty 8, got ${ganho?.quantidade}`);
    if (!saida || Number(saida.quantidade) !== 5) throw new Error(`esperava S nf_venda qty 5, got ${saida?.quantidade}`);

    const { data: sessao } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("continua", true)
      .maybeSingle();
    if (!sessao) throw new Error("esperava sessão operacional contínua do galpão");

    const { data: contagem } = await ctx.sb
      .from("siso_inventario_contagens")
      .select("qty_contada")
      .eq("sessao_id", sessao.id)
      .eq("produto_id", produto!.id)
      .maybeSingle();
    if (!contagem || Number(contagem.qty_contada) !== 8) throw new Error("esperava contagem qty 8");

    const { data: div } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("status, qty_contada_final, saldo_sistema")
      .eq("sessao_id", sessao.id)
      .eq("produto_id", produto!.id)
      .maybeSingle();
    if (!div || div.status !== "aplicada") throw new Error("esperava divergência aplicada");

    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("ultima_contagem_em")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-06-01")
      .single();
    if (!loc?.ultima_contagem_em) throw new Error("esperava ultima_contagem_em na loc");

    // D2: a contagem entra na acuracidade do operador
    const { data: metricas, error: mErr } = await ctx.sb.rpc("wms_metricas_operador");
    if (mErr) throw new Error(`wms_metricas_operador erro: ${mErr.message}`);
    const runner = (metricas as Array<{ nome: string; contagens: number }> | null ?? []).find((m) => m.nome === "test-runner");
    if (!runner || Number(runner.contagens) < 1) throw new Error("esperava contagem do test-runner na acuracidade");
  },
} satisfies Cenario<{ sku: string; locId: string }>;

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
