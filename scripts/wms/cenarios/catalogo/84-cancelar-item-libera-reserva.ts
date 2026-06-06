// scripts/wms/cenarios/catalogo/84-cancelar-item-libera-reserva.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 84 — confirmar cancelamento de item de compra libera a R viva (P039/P038).
 *
 * Semeia um pedido com 1 item OC e uma R viva (origem_id=pedido, reserva_pedido)
 * apontando pra (produto, galpão, loc). Marca o item p/ cancelamento e confirma.
 * Espera: após confirmar, reservado da tripla volta a 0 (R liberada via L).
 * RED hoje: a rota confirma o cancelamento mas deixa a R presa.
 */
type Setup = { sku: string; pedidoId: string; itemId: string; produtoId: string; galpaoId: string; locId: string };

export default {
  nome: "84-cancelar-item — cancelar item de compra libera reserva R (P039/P038)",
  descricao:
    "Pedido OC com R viva. Confirmar cancelamento do item → reservado volta a 0.",
  tags: ["cancelamento", "compra", "reserva", "P038", "P039"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("84");
    await ctx.criarProduto({ sku, descricao: "Cancelar item libera R 84" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 5 });
    // Look up the WMS product UUID (criarProduto returns the sku, not the uuid).
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const produtoId = (prod as { id: string }).id;
    const { data: g } = await ctx.sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const galpaoId = (g as { id: string }).id;
    const { data: l } = await ctx.sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-02").single();
    const locId = (l as { id: string }).id;
    return { sku, pedidoId: "", itemId: "", produtoId, galpaoId, locId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, produtoId, galpaoId, locId } = setup;
    const empresaId = ctx.staging.empresas.netair.id;
    const pedidoId = `cancel-item-84-${Date.now()}`;
    setup.pedidoId = pedidoId;

    // Pedido sintético em fluxo de compra (espelha estado pós-reconciliação).
    await ctx.sb.from("siso_pedidos").insert({
      id: pedidoId,
      numero: pedidoId,
      empresa_origem_id: empresaId,
      filial_origem: "CWB",
      cliente_nome: "Cancel Item 84",
      origem_pedido: "webhook",
      status: "executando",
      status_separacao: "aguardando_compra",
      data: new Date().toISOString().slice(0, 10),
      criado_em: new Date().toISOString(),
    });

    // produto_id é o tiny_produto_id (gotcha) — usamos um placeholder válido do mapeamento.
    const { data: mapRow } = await ctx.sb
      .from("siso_produto_empresas")
      .select("tiny_produto_id")
      .eq("empresa_id", empresaId)
      .eq("produto_id", produtoId)
      .maybeSingle();
    const tinyId = mapRow ? Number((mapRow as { tiny_produto_id: number }).tiny_produto_id) : 999999;

    const { data: item } = await ctx.sb.from("siso_pedido_itens").insert({
      pedido_id: pedidoId,
      produto_id: tinyId,
      produto_id_tiny: tinyId,
      sku,
      descricao: "Cancel Item 84",
      quantidade_pedida: 2,
      compra_status: "cancelamento_pendente",
      compra_cancelamento_motivo: "teste",
    }).select("id").single();
    setup.itemId = String((item as { id: string }).id);

    // R viva pra (produto, galpão, loc) ligada ao pedido (espelha reconciliador-oc).
    const { error: rErr } = await ctx.sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_quantidade: 2,
      p_pedido_id: pedidoId,
      p_ttl_horas: 24 * 30,
      p_usuario_id: null,
    });
    if (rErr) throw new Error(`falha ao reservar R para pedido ${pedidoId}: ${rErr.message}`);
    await ctx.assertReservado(sku, "CWB", "A-01-02", 2);

    // Confirma cancelamento do item.
    await ctx.http.post(`/api/wms/compras/itens/${setup.itemId}/cancelamento/confirmar`, {});
    await ctx.aguardar(1200);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;
    // R liberada → reservado volta a 0.
    await ctx.assertReservado(sku, "CWB", "A-01-02", 0);
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<Setup>;

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
