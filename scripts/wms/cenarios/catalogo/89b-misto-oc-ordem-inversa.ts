import type { Cenario, Ctx } from "../_harness/types";

interface Setup {
  skuA: string;
  skuB: string;
  state: { pedidoId: string };
}

export default {
  nome: "89b — misto OC ordem inversa: guard evita transição prematura",
  descricao:
    "Pedido misto (skuA com saldo, skuB sem). Resolve OC item ('esgotado' em skuB) " +
    "ANTES de marcar o item normal (skuA). Garante que o guard separacao_marcado " +
    "impede a transição prematura para aguardando_compra. Depois marca skuA e chama " +
    "/concluir — pedido deve chegar a aguardando_compra pelo fallback do concluir.",
  tags: ["separacao", "validar-oc-item", "esgotado", "misto", "oc", "compras", "guard", "ordem-inversa"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuA = ctx.skuUnico("89bA");
    const skuB = ctx.skuUnico("89bB");

    await ctx.criarProduto({ sku: skuA, descricao: "Misto 89b - Com Saldo" });
    await ctx.criarProduto({ sku: skuB, descricao: "Misto 89b - Sem Saldo" });

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

    // Inicia separação
    await ctx.iniciarSeparacao(pedido.id);

    // Busca item IDs
    const { data: itemB } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedido.id)
      .eq("sku", skuB)
      .single();

    if (!itemB) {
      throw new Error(`Não encontrou item do pedido para sku=${skuB}`);
    }

    // ORDEM INVERSA: esgotado em skuB ANTES de marcar skuA
    // O guard deve impedir a transição prematura (skuA ainda não está marcado)
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [itemB.id],
      acao: "esgotado",
    });

    // Verifica que NÃO transitou prematuramente — skuA ainda não foi marcado
    const { data: pedidoMid } = await ctx.sb
      .from("siso_pedidos")
      .select("status_separacao")
      .eq("id", pedido.id)
      .single();

    if (!pedidoMid) throw new Error(`pedido ${pedido.id} não encontrado na verificação mid`);
    if (pedidoMid.status_separacao !== "em_separacao") {
      throw new Error(
        `Guard premature: esperava em_separacao (skuA ainda não bipado), obteve '${pedidoMid.status_separacao}' — separacao_marcado.every() avaliou true cedo demais`,
      );
    }

    // Agora marca skuA (normal)
    await ctx.bipar({ pedido: pedido.id, item: skuA, qty: 1 });

    // Chama concluir — o fallback do concluir deve transicionar pra aguardando_compra
    await ctx.concluirSeparacao(pedido.id);
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
        `Esperava status_separacao='aguardando_compra' após concluir, mas obteve '${pedido.status_separacao}'.`,
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
