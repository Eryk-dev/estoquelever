import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "63 — Encontrei sem cadastro gera Entrada+Saída",
  descricao:
    "Decisão 3 (28/05): quando o produto não tem nenhuma loc com saldo no " +
    "galpão e o operador acha fisicamente em separação, o sistema usa a " +
    "loc bipada pelo operador (modal Onde você achou?) pra gerar par " +
    "Entrada (qty pedido) + Saída (qty pedido). Saldo final 0 mas a loc " +
    "passa a ter histórico daquele produto.",
  tags: ["separacao", "validar-oc", "encontrei", "fase1"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("63");
    await ctx.criarProduto({ sku, descricao: "Encontrei sem cadastro 63" });
    // Cria loc destino "A-05-03" mas SEM seedar saldo — produto fica órfão.
    // Captura o UUID da loc para passá-lo diretamente em validar-oc-item
    // (siso_pedido_item_estoques foi dropada; snapshot não existe mais).
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "A-05-03" });
    return { sku, locId };
  },

  run: async (ctx: Ctx, { sku, locId }: { sku: string; locId: string }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    // Pós F1 (auto-OC): OC é auto-aprovada pelo webhook, aguarda validacao_oc.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // Simula bipe da loc: chama /separacao/localizacao salvando "A-05-03" no snapshot
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedido.id)
      .eq("sku", sku)
      .single();

    // Operador confirma encontrei passando localizacao_id (UUID) diretamente
    // (siso_pedido_item_estoques foi dropada; loc vem do body, não de snapshot).
    // /validar-oc-item detecta semSaldo → gera mov E (entrada qty=2) + mov S (saída qty=2).
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [String(itemRow!.id)],
      acao: "encontrei",
      localizacao_id: locId,
    });
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string; locId: string }) => {
    // Saldo final na A-05-03 deve ser 0 (E+S cancelaram)
    await ctx.assertSaldo(sku, "CWB", "A-05-03", 0);

    // Confere movs: deve ter 1 E (achado) + 1 S (encontrei_oc)
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("tipo, quantidade, origem_tipo, motivo_categoria")
      .eq("produto_id", produto!.id)
      .order("criado_em", { ascending: true });
    const ent = (movs ?? []).find(
      (m) =>
        m.tipo === "E" &&
        m.origem_tipo === "ajuste_manual" &&
        m.motivo_categoria === "achado",
    );
    const sai = (movs ?? []).find(
      (m) => m.tipo === "S" && m.origem_tipo === "nf_venda",
    );
    if (!ent) throw new Error("esperava mov E ajuste_manual achado");
    if (!sai) throw new Error("esperava mov S nf_venda");
    if (Number(ent.quantidade) !== 2) {
      throw new Error(`mov E qty esperava 2, recebi ${ent.quantidade}`);
    }
    if (Number(sai.quantidade) !== 2) {
      throw new Error(`mov S qty esperava 2, recebi ${sai.quantidade}`);
    }
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
