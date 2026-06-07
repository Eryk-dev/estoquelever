import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
});

// Produto fresco por teste — isola o estado da loc (A-01-01) entre casos, já
// que a suíte só trunca no globalSetup (1x por run). Sem isso, o saldo/reservado
// residual do 1º teste falseia a aritmética do clamp do 2º (determinismo).
async function novoProduto() {
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-DESM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, descricao: "x", ativo: true })
    .select("id").single();
  prodId = p!.id;
}

// Helper: cria pedido + item + R, faz pick (L+S) e devolve os ids.
async function prepararPickado(pedidoId: string, qty: number, saldoInicial: number) {
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: saldoInicial, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
  const expira = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  const { data: rId } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "R", p_quantidade: qty, p_origem_tipo: "reserva_pedido", p_origem_id: pedidoId,
    p_expira_em: expira, p_motivo: "reserva",
  });
  const pick = await sb.rpc("wms_pick_item_atomico", {
    p_reserva_id: rId.data ?? rId, p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_qty: qty, p_pedido_id: pedidoId, p_empresa_vendedora_id: empresaId,
  });
  return pick.data as { mov_l_id: string; mov_s_id: string };
}

describe("wms_desmarcar_item_atomico", () => {
  it("estorna S+L atômico: saldo e reservado voltam ao estado pré-pick (sem clamp)", async () => {
    await novoProduto();
    const pedidoId = "700000001";
    const { mov_l_id, mov_s_id } = await prepararPickado(pedidoId, 4, 10);
    // pós-pick: saldo 6, reservado 0
    const { data, error } = await sb.rpc("wms_desmarcar_item_atomico", {
      p_mov_s_id: mov_s_id, p_mov_l_id: mov_l_id, p_pedido_id: pedidoId, p_usuario_id: null,
      p_motivo: "desmarca",
    });
    expect(error).toBeNull();
    expect((data as { status_alerta: string | null }).status_alerta).toBeNull(); // S==L → sem clamp
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(10);     // E counter recuperou
    expect(Number(est?.reservado)).toBe(4);  // R recriada cheia
  });

  // D4 — CLAMP DETERMINÍSTICO. Para o clamp reduzir a R, a qty a recriar (lida
  // do L via p_mov_l_id) precisa EXCEDER o que o estorno-S restaura. Como a RPC
  // lê v_l.quantidade pra R e v_s.quantidade pro estorno INDEPENDENTEMENTE,
  // construímos um L(8) e um S(5) distintos numa loc apertada: pós-estorno-S o
  // saldo livre fica 5 < qty_R 8 → clamp pra 5 + status_alerta.
  // (Quando S.qty == L.qty no mesmo loc, livre_pós_estorno = saldo - reservado +
  // qty_S >= qty_R sempre, pelo invariante reservado<=saldo — clamp não dispara;
  // por isso o teste usa qty distintas, o caso real do desmarcar de completa-parcial.)
  it("D4 tolerante: recriar a R excede o saldo livre → clampa + status_alerta", async () => {
    await novoProduto();
    const pedidoId = "700000002";
    // Seed E 8 → saldo 8.
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 8, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
    });
    const expira = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    // R 8 → reservado 8, depois L 8 → reservado 0 (L mov quantidade=8).
    const { data: rId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "R", p_quantidade: 8, p_origem_tipo: "reserva_pedido", p_origem_id: pedidoId,
      p_expira_em: expira, p_pedido_id: pedidoId, p_motivo: "reserva original",
    });
    const { data: lId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "L", p_quantidade: 8, p_origem_tipo: "liberacao_reserva", p_origem_id: pedidoId,
      p_estorno_de: (rId.data ?? rId) as string, p_pedido_id: pedidoId, p_motivo: "libera",
    });
    // S 5 → saldo 3 (S mov quantidade=5, < L).
    const { data: sId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 5, p_origem_tipo: "nf_venda", p_origem_id: pedidoId,
      p_empresa_vendedora_id: empresaId, p_pedido_id: pedidoId, p_motivo: "saida parcial",
    });
    // Terceiro consome os 3 livres → saldo 0.
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 3, p_origem_tipo: "venda_manual", p_motivo: "terceiro consome livre",
    });
    // Desmarcar: estorno-S(5) → saldo 5, reservado 0, livre 5. Recriar R(8): 5 < 8
    // → CLAMP pra 5 + status_alerta='reserva_clampada_pos_desmarca'.
    const { data, error } = await sb.rpc("wms_desmarcar_item_atomico", {
      p_mov_s_id: (sId.data ?? sId) as string, p_mov_l_id: (lId.data ?? lId) as string,
      p_pedido_id: pedidoId, p_usuario_id: null, p_motivo: "desmarca tardia",
    });
    expect(error).toBeNull();
    const res = data as { status_alerta: string | null };
    expect(res.status_alerta).toBe("reserva_clampada_pos_desmarca");
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est!.saldo)).toBe(5);            // estorno-S restaurou +5
    expect(Number(est!.reservado)).toBe(5);        // R clampada a 5 (não 8)
    expect(Number(est!.reservado)).toBeLessThanOrEqual(Number(est!.saldo)); // invariante
  });
});
