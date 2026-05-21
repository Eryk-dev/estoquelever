import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let galpaoId: string;
let locId: string;
const SKU = `TEST-INT-LEDGER-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-01")
    .single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Ledger RPC test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
});

describe("wms_inserir_movimentacao", () => {
  it("entrada simples atualiza saldo no cache", async () => {
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_tipo: "E",
      p_quantidade: 10,
      p_origem_tipo: "inventario_inicial",
      p_origem_id: null,
      p_custo_unitario: 5,
      p_motivo: "test",
    });
    expect(error).toBeNull();
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(est?.saldo)).toBe(10);
  });

  it("saída maior que saldo retorna erro", async () => {
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_tipo: "S",
      p_quantidade: 999,
      p_origem_tipo: "venda_manual",
      p_origem_id: null,
      p_custo_unitario: null,
      p_motivo: "overflow",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/saldo|insuficiente|reservado/i);
  });

  it("entrada com custo_unitario recalcula custo médio global", async () => {
    // Primeira já criada com custo 5. Adiciona +10 unidades com custo 15 → média ponderada = (10*5 + 10*15)/20 = 10.
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_tipo: "E",
      p_quantidade: 10,
      p_origem_tipo: "nf_compra",
      p_origem_id: null,
      p_custo_unitario: 15,
      p_motivo: "test custo médio",
    });
    expect(error).toBeNull();
    const { data: cm } = await sb
      .from("siso_custo_medio")
      .select("custo_medio")
      .eq("produto_id", produtoId)
      .single();
    expect(Number(cm?.custo_medio)).toBeCloseTo(10, 3);
  });
});
