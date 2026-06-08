import type { Cenario, Ctx } from "../_harness/types";

// TSetup é mutável: run() escreve pedidoId depois de criar o pedido.
type Setup = { sku: string; locId: string; pedidoId: string | null };

export default {
  nome: "90 — Solicitar contagem depois: pega qty do pedido + enfileira loc (sem contagem inline)",
  descricao:
    "Item OC com qty 2 numa loc. Operador achou o item mas não quer " +
    "contar agora: usa solicitar_contagem=true. Sistema gera par E+S " +
    "de qty=2 (sem reconciliar a loc toda), enfileira a loc na sessão " +
    "operacional contínua com status=pendente / motivo=solicitada_pick. " +
    "Saldo da loc fica temporariamente subcontado de propósito.",
  tags: ["separacao", "validar-oc", "encontrei", "solicitar-contagem", "fase4"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("90");
    await ctx.criarProduto({ sku, descricao: "Solicitar contagem 90" });
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-09-01" });
    return { sku, locId, pedidoId: null };
  },

  run: async (ctx: Ctx, setup: Setup) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: setup.sku, qty: 2 }],
    });
    // Pós F1 (auto-OC): OC é auto-aprovada pelo webhook, aguarda validacao_oc.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // Salva no setup mutável pra assertEsperado poder checar o pedido
    setup.pedidoId = pedido.id;

    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id, produto_id")
      .eq("pedido_id", pedido.id)
      .eq("sku", setup.sku)
      .single();

    // Operador usa "Solicitar contagem depois" — só passa loc_codigo + solicitar_contagem=true
    // (sem qty_contada — não está contando agora, só pegando a qty do pedido)
    const resp = await ctx.http.post<{ itens_atualizados?: number; error?: string }>(
      "/api/wms/separacao/validar-oc-item",
      {
        item_ids: [String(itemRow!.id)],
        acao: "encontrei",
        solicitar_contagem: true,
        localizacao_codigo: "A-09-01",
      },
    );
    if (resp.error) throw new Error(`validar-oc-item falhou: ${resp.error}`);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup) => {
    const { sku, locId, pedidoId } = setup;

    // 1) Exatamente 1 mov S (nf_venda) de qty 2 + 1 mov E (ajuste_manual achado) de qty 2
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, quantidade, origem_tipo")
      .eq("produto_id", produto!.id)
      .order("criado_em", { ascending: true });

    const ent = (movs ?? []).find((m) => m.tipo === "E" && m.origem_tipo === "ajuste_manual");
    if (!ent) throw new Error("esperava mov E ajuste_manual (achado no pick sem contagem inline)");
    if (Number(ent.quantidade) !== 2) {
      throw new Error(`mov E qty esperava 2, recebi ${ent.quantidade}`);
    }

    const saidas = (movs ?? []).filter((m) => m.tipo === "S" && m.origem_tipo === "nf_venda");
    if (saidas.length !== 1) throw new Error(`esperava 1 S nf_venda, recebi ${saidas.length}`);
    if (Number(saidas[0].quantidade) !== 2) {
      throw new Error(`mov S nf_venda qty esperava 2, recebi ${saidas[0].quantidade}`);
    }

    // 2) NÃO houve contagem inline — não deve existir nenhuma entrada de
    //    inventario_ganho (registrarContagemInline nunca foi chamada)
    const contgInline = (movs ?? []).find((m) => m.origem_tipo === "inventario_ganho");
    if (contgInline) {
      throw new Error(
        "registrarContagemInline foi chamada — não deveria (solicitar_contagem=true não reconcilia a loc)",
      );
    }

    // Confirma também que não há contagem registrada na sessão contínua para este produto
    const { data: sessaoOp } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("continua", true)
      .maybeSingle();

    if (sessaoOp) {
      const { data: contagem } = await ctx.sb
        .from("siso_inventario_contagens")
        .select("id")
        .eq("sessao_id", sessaoOp.id)
        .eq("produto_id", produto!.id)
        .maybeSingle();
      if (contagem) {
        throw new Error(
          "encontrou linha em siso_inventario_contagens — não deveria (contagem adiada, não feita agora)",
        );
      }
    }

    // 3) Deve haver exatamente 1 linha em siso_inventario_localizacoes com
    //    status='pendente' e motivo='solicitada_pick' para a loc A-09-01
    if (!sessaoOp) throw new Error("esperava sessão operacional contínua do galpão CWB");

    const { data: locEnfileirada } = await ctx.sb
      .from("siso_inventario_localizacoes")
      .select("id, status, motivo")
      .eq("sessao_id", sessaoOp.id)
      .eq("localizacao_id", locId)
      .maybeSingle();
    if (!locEnfileirada) {
      throw new Error("esperava linha em siso_inventario_localizacoes para a loc A-09-01");
    }
    if (locEnfileirada.status !== "pendente") {
      throw new Error(`esperava status=pendente, recebi ${locEnfileirada.status}`);
    }
    if (locEnfileirada.motivo !== "solicitada_pick") {
      throw new Error(`esperava motivo=solicitada_pick, recebi ${locEnfileirada.motivo}`);
    }

    // 4) Pedido transicionou per FR-9 (todos OC encontrados → aguardando_separacao)
    if (pedidoId) {
      const { data: pedido } = await ctx.sb
        .from("siso_pedidos")
        .select("status_separacao, decisao_final")
        .eq("id", pedidoId)
        .single();
      if (!pedido) throw new Error("pedido não encontrado");
      if (pedido.decisao_final !== "propria") {
        throw new Error(`esperava decisao_final=propria, recebi ${pedido.decisao_final}`);
      }
      if (
        pedido.status_separacao !== "aguardando_separacao" &&
        pedido.status_separacao !== "em_separacao" &&
        pedido.status_separacao !== "separado"
      ) {
        throw new Error(
          `esperava status_separacao=aguardando_separacao (ou mais avançado), recebi ${pedido.status_separacao}`,
        );
      }
    }
  },
} satisfies Cenario<Setup>;

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
