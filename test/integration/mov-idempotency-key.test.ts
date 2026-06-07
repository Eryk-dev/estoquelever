import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-IDEMP-${Date.now()}`, descricao: "idemp", ativo: true }).select("id").single();
  prodId = p!.id;
  // saldo inicial
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 50, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("siso_movimentacoes.idempotency_key UNIQUE parcial", () => {
  it("rejeita 2ª mov com mesmo idempotency_key (23505)", async () => {
    const key = crypto.randomUUID();
    const ins1 = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 50, saldo_posterior: 49, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: key,
    });
    expect(ins1.error).toBeNull();
    const ins2 = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 49, saldo_posterior: 48, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: key,
    });
    expect(ins2.error?.code).toBe("23505");
  });

  it("permite múltiplas movs com idempotency_key NULL (legado)", async () => {
    const a = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 48, saldo_posterior: 47, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: null,
    });
    const b = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 47, saldo_posterior: 46, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: null,
    });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });
});
