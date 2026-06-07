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
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-PARC-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 20, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("wms_pick_parcial_atomico", () => {
  it("S(qty) + ajuste(delta) atômicos: rollback total se o ajuste estourar", async () => {
    // saldo 20, qty_pega 5, delta_ajuste enorme (25) que deixaria saldo negativo → rollback.
    const { error } = await sb.rpc("wms_pick_parcial_atomico", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty_pega: 5, p_delta_ajuste: 25, p_pedido_id: "888000222",
      p_empresa_vendedora_id: empresaId, p_origem_detalhes: { contexto: "test" },
    });
    expect(error).not.toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(20); // nenhuma S/ajuste persistiu
  });

  it("aplica S(5) + ajuste(3) numa tx (saldo 20→12)", async () => {
    const { data, error } = await sb.rpc("wms_pick_parcial_atomico", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty_pega: 5, p_delta_ajuste: 3, p_pedido_id: "888000333",
      p_empresa_vendedora_id: empresaId, p_origem_detalhes: { contexto: "test" },
    });
    expect(error).toBeNull();
    expect((data as { mov_s_id: string }).mov_s_id).toBeTruthy();
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(12);
  });
});
