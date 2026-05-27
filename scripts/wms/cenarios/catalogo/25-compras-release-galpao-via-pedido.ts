import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 25 — compras-release deve decidir propria/transferencia
 * comparando OC.galpao_id com pedido.separacao_galpao_id (source-of-truth),
 * NÃO com siso_empresas.galpao_id (deprecated — espelho do 1º preferencial).
 *
 * Setup: pedido empresa=NetAir (preferencial CWB), MAS força
 * separacao_galpao_id=SP pra simular roteamento cross-galpão. OC no galpão SP.
 *
 * Antes do fix: resolveEmpresaGalpaoId(NetAir) → CWB → mesmoGalpao=false →
 *   decisao=transferencia (errado).
 * Depois do fix: pedidoGalpaoId=pedido.separacao_galpao_id=SP → mesmoGalpao=true →
 *   decisao=propria (correto).
 */
export default {
  nome: "25 — compras-release usa separacao_galpao_id ao invés de empresa.galpao_id deprecated",
  descricao:
    "Pedido NetAir (preferencial CWB) roteado pra SP + OC no SP deve liberar como propria — " +
    "decisão tem que vir de separacao_galpao_id, não de siso_empresas.galpao_id deprecated.",
  tags: ["compras-release", "galpao", "deprecated-cleanup"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("25");
    await ctx.criarProduto({ sku, descricao: "Item compras-release galpão 25" });
    // Sem saldo — pedido vai pra OC.
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const { checkAndReleasePedidos } = await import("../../../../src/lib/compras-release");

    // 1. Webhook entra sem saldo → sugestao=oc
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "oc" });

    // 2. Força separacao_galpao_id=SP (simula roteamento cross-galpão).
    //    NetAir é preferencial CWB, mas roteamento decidiu SP.
    const { error: updPedErr } = await ctx.sb
      .from("siso_pedidos")
      .update({
        separacao_galpao_id: ctx.staging.galpoes.sp.id,
        status_separacao: "aguardando_compra",
      })
      .eq("id", pedido.id);
    if (updPedErr) throw new Error(`update pedido: ${updPedErr.message}`);

    // 3. Cria OC no galpão SP
    const { data: oc, error: ocErr } = await ctx.sb
      .from("siso_ordens_compra")
      .insert({
        galpao_id: ctx.staging.galpoes.sp.id,
        status: "rascunho",
        fornecedor_nome: "TestFornecedor-25",
      })
      .select("id")
      .single();
    if (ocErr || !oc) throw new Error(`insert oc: ${ocErr?.message}`);

    // 4. Linka item à OC e marca como recebido
    const { data: itens, error: itensErr } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedido.id);
    if (itensErr || !itens) throw new Error(`select itens: ${itensErr?.message}`);

    const { error: updItErr } = await ctx.sb
      .from("siso_pedido_itens")
      .update({
        compra_status: "recebido",
        ordem_compra_id: oc.id,
      })
      .eq("pedido_id", pedido.id);
    if (updItErr) throw new Error(`update item: ${updItErr.message}`);

    // 5. Dispara o release manualmente
    const released = await checkAndReleasePedidos(itens.map((i) => i.id as string));
    if (!released.includes(pedido.id)) {
      throw new Error(`pedido ${pedido.id} deveria ter sido liberado por checkAndReleasePedidos`);
    }

    // Guarda o id pro assert
    ctx.log("release executado", { pedido_id: pedido.id, oc_id: oc.id });
    (ctx as unknown as { _cenario25_pedido_id?: string })._cenario25_pedido_id = pedido.id;
  },

  assertEsperado: async (ctx) => {
    const pedidoId = (ctx as unknown as { _cenario25_pedido_id?: string })._cenario25_pedido_id;
    if (!pedidoId) throw new Error("pedido_id não foi capturado no run");

    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("decisao_final, status_separacao, separacao_galpao_id")
      .eq("id", pedidoId)
      .single();

    if (!pedido) throw new Error(`pedido ${pedidoId} não encontrado`);

    // OC.galpao=SP, pedido.separacao_galpao_id=SP → mesmoGalpao → propria.
    // Antes do fix: empresa NetAir.galpao_id=CWB ≠ SP → transferencia (errado).
    if (pedido.decisao_final !== "propria") {
      throw new Error(
        `decisao_final esperada=propria, recebida=${pedido.decisao_final} ` +
        `(galpao_id deprecated foi consultado em vez de separacao_galpao_id)`,
      );
    }
    if (pedido.separacao_galpao_id !== ctx.staging.galpoes.sp.id) {
      throw new Error(
        `separacao_galpao_id esperado=${ctx.staging.galpoes.sp.id}, ` +
        `recebido=${pedido.separacao_galpao_id}`,
      );
    }
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

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
