import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 86 — [P084] resolver pedido-fantasma (padrão C do safety-net).
 *
 * Monta um pedido forward (status_separacao='separado') com uma reserva R viva
 * sem L estornando — as unidades ficam congeladas (nem em saída, nem livres).
 * O safety-net (GET /reconciliacao-pedidos) só DETECTA isso; a rota POST
 * /[pedidoId]/resolver é a AÇÃO. Aqui, acao='cancelado': devolve à prateleira
 * (R→L, reservado zera, saldo intacto) e marca o pedido cancelado.
 *
 * Caso negativo: sem header de sessão → 401/403 (gate admin via requireAdmin).
 */
type Setup = { sku: string; loc: string; pedidoId: string; prodId: string; locId: string; galpaoId: string };

export default {
  nome: "86 — [P084] resolver pedido-fantasma (R→prateleira, cancelado) + gate admin",
  descricao:
    "Pedido forward com R viva: POST resolver {acao:cancelado} libera a R e cancela o pedido; sem sessão dá 401/403.",
  tags: ["reconciliacao", "pedido-fantasma", "reserva", "ledger", "P084"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("86");
    await ctx.criarProduto({ sku, descricao: "fantasma 86" });
    const loc = "FANT86-01";
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: loc, tipo: "picking" });

    const galpaoId = ctx.staging.galpoes.cwb.id;
    const empresaId = ctx.staging.empresas.netair.id;
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const prodId = (prod as { id: string }).id;
    const { data: locRow } = await ctx.sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", loc).single();
    const locId = (locRow as { id: string }).id;

    // Pedido forward (separado) com empresa de origem pra tag da S no caso 'saiu'.
    const pedidoId = "860000001";
    await ctx.sb.from("siso_pedidos").insert({
      id: pedidoId,
      numero: pedidoId,
      data: new Date().toISOString().slice(0, 10),
      filial_origem: "CWB",
      cliente_nome: "Fantasma 86",
      status: "executando",
      status_separacao: "separado",
      empresa_origem_id: empresaId,
    });

    // Saldo + reserva R viva (origem_tipo=reserva_pedido, origem_id=pedido).
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc, qty: 9 });
    const expira = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    const { error: rErr } = await ctx.sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "R", p_quantidade: 4, p_origem_tipo: "reserva_pedido", p_origem_id: pedidoId,
      p_expira_em: expira, p_pedido_id: pedidoId, p_motivo: "reserva fantasma 86",
    });
    if (rErr) throw new Error(`setup reserva: ${rErr.message}`);

    return { sku, loc, pedidoId, prodId, locId, galpaoId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Precondição: reservado=4 (R viva, congelada).
    await ctx.assertReservado(setup.sku, "CWB", setup.loc, 4);

    // Caso negativo: sem sessão → 401/403.
    let negStatus = 0;
    try {
      await ctx.http.post(
        `/api/wms/reconciliacao-pedidos/${setup.pedidoId}/resolver`,
        { acao: "cancelado" },
        { "X-Session-Id": "" },
      );
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      negStatus = Number((m.match(/HTTP (\d+)/) ?? [])[1] ?? 0);
    }
    if (negStatus !== 401 && negStatus !== 403) {
      throw new Error(`sem sessão esperava 401/403, recebeu ${negStatus}`);
    }

    // Ação real (autenticado como admin via header de sessão do harness).
    await ctx.http.post(`/api/wms/reconciliacao-pedidos/${setup.pedidoId}/resolver`, { acao: "cancelado" });
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // R liberada: reservado zera, saldo intacto (cancelado não baixa).
    await ctx.assertReservado(setup.sku, "CWB", setup.loc, 0);
    await ctx.assertSaldo(setup.sku, "CWB", setup.loc, 9);
    // Pedido marcado cancelado (coluna `status`; status_separacao permanece
    // 'separado', então leio status diretamente em vez de assertPedidoStatus,
    // que prioriza status_separacao).
    const { data: ped } = await ctx.sb.from("siso_pedidos").select("status").eq("id", setup.pedidoId).single();
    const status = (ped as { status: string } | null)?.status;
    if (status !== "cancelado") {
      throw new Error(`pedido esperava status=cancelado, real=${status}`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
