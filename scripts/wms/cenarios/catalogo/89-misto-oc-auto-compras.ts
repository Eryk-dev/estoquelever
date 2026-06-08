import type { Cenario, Ctx } from "../_harness/types";

interface Setup {
  skuA: string;
  skuB: string;
  state: { pedidoId: string };
}

export default {
  nome: "89 — pedido misto OC auto-transiciona pra Compras quando normais pegos",
  descricao:
    "Pedido com 2 SKUs: skuA com saldo (vai virar normal/marcado no pick); " +
    "skuB sem saldo (vai pra compra via 'esgotado'). " +
    "Após pick do skuA + esgotado no skuB, o pedido deve auto-transicionar pra " +
    "aguardando_compra SEM precisar chamar /concluir.",
  tags: ["separacao", "validar-oc-item", "esgotado", "misto", "oc", "compras", "auto-transicao"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("89A");
    const skuB = ctx.skuUnico("89B");

    await ctx.criarProduto({ sku: skuA, descricao: "Misto 89 - Com Saldo" });
    await ctx.criarProduto({ sku: skuB, descricao: "Misto 89 - Sem Saldo" });

    // Semeia saldo só pra skuA → pedido vai OC (skuB zera a cobertura total)
    await ctx.semearSaldo({ produto: skuA, galpao: "CWB", loc: "DEFAULT-PICKING", qty: 5 });
    // skuB sem saldo intencional → roteamento vai OC

    return { skuA, skuB, state: { pedidoId: "" } };
  },

  run: async (ctx: Ctx, setup: Setup) => {
    const { skuA, skuB } = setup;

    // Webhook com ambos os itens → roteamento OC (skuB zera cobertura total)
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [
        { sku: skuA, qty: 1 },
        { sku: skuB, qty: 1 },
      ],
    });

    // Salva pedidoId para o assert
    setup.state.pedidoId = pedido.id;

    // Pós F1 (auto-OC): webhook auto-aprova OC diretamente pra validacao_oc.
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 15_000 });

    // Inicia separação para poder marcar itens
    await ctx.iniciarSeparacao(pedido.id);

    // Busca o item id do skuB (o que vai para esgotado/compra)
    const { data: itemB } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedido.id)
      .eq("sku", skuB)
      .single();

    if (!itemB) {
      throw new Error(`Não encontrou item do pedido para sku=${skuB}`);
    }

    // skuA: marca como pego via bipar (seta separacao_marcado=true via marcar-item)
    await ctx.bipar({ pedido: pedido.id, item: skuA, qty: 1 });

    // skuB: "esgotado" (sem saldo, vai pra compra)
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [itemB.id],
      acao: "esgotado",
    });

    // Neste ponto, sem chamar /concluir, o pedido já deve ter transitado pra
    // aguardando_compra automaticamente (todos normais marcados + todos OC esgotados).
  },

  assertEsperado: async (ctx: Ctx, setup: Setup) => {
    const { state } = setup;

    if (!state.pedidoId) {
      throw new Error("pedidoId não foi populado no run");
    }

    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("id, status_separacao")
      .eq("id", state.pedidoId)
      .single();

    if (!pedido) {
      throw new Error(`Pedido ${state.pedidoId} não encontrado no assert`);
    }

    if (pedido.status_separacao !== "aguardando_compra") {
      throw new Error(
        `Esperava status_separacao='aguardando_compra' (sem concluir), mas obteve '${pedido.status_separacao}'. ` +
          "Pedido misto não auto-transicionou — FASE 3 não implementada.",
      );
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
