import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locA: string, locB: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: la } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locA = la!.id;
  const { data: lb } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-02").single();
  locB = lb!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-BD-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  for (const loc of [locA, locB]) {
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: loc,
      p_tipo: "E", p_quantidade: 5, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
    });
  }
});

describe("wms_vender_baixa_direta_atomico", () => {
  it("baixa N movs S em locs distintas numa tx; rollback total se uma exceder saldo", async () => {
    const origemId = crypto.randomUUID();
    // pede 5 de locA (ok) + 8 de locB (só tem 5 → falha) → rollback total.
    const { error } = await sb.rpc("wms_vender_baixa_direta_atomico", {
      p_origem_venda_id: origemId, p_pedido_id_manual: "MAN-fail-1",
      p_empresa_vendedora_id: empresaId, p_cliente_nome: "Cli", p_usuario_id: null,
      p_movs: [
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locA, qty: 5, sku: "x" },
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locB, qty: 8, sku: "x" },
      ],
    });
    expect(error).not.toBeNull();
    // nenhuma S persistiu: saldos intactos
    const { data: ea } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("localizacao_id", locA).single();
    expect(Number(ea?.saldo)).toBe(5);
  });

  it("baixa 5+3 com sucesso (saldos 0 e 2)", async () => {
    const origemId = crypto.randomUUID();
    const { data, error } = await sb.rpc("wms_vender_baixa_direta_atomico", {
      p_origem_venda_id: origemId, p_pedido_id_manual: "MAN-ok-1",
      p_empresa_vendedora_id: empresaId, p_cliente_nome: "Cli", p_usuario_id: null,
      p_movs: [
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locA, qty: 5, sku: "x" },
        { produto_id: prodId, galpao_id: galpaoId, localizacao_id: locB, qty: 3, sku: "x" },
      ],
    });
    expect(error).toBeNull();
    expect((data as { mov_ids: string[] }).mov_ids.length).toBe(2);
    const { data: ea } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locA).single();
    const { data: eb } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locB).single();
    expect(Number(ea?.saldo)).toBe(0);
    expect(Number(eb?.saldo)).toBe(2);
  });
});
