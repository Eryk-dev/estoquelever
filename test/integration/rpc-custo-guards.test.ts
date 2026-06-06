import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let galpaoId: string;
let locId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
});

async function novoProduto(label: string): Promise<string> {
  const sku = `TEST-CUSTO-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const { data } = await sb
    .from("siso_produtos").insert({ sku, descricao: `custo guard ${label}`, ativo: true })
    .select("id").single();
  return data!.id;
}

describe("P108 — guard custo-zero", () => {
  it("rejeita entrada nf_compra com custo_unitario=0 e qty>0", async () => {
    const produtoId = await novoProduto("zero");
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 5, p_origem_tipo: "nf_compra",
      p_origem_id: null, p_custo_unitario: 0, p_motivo: "custo zero",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/custo zero|custo.*0/i);
    // custo médio NÃO virou 0
    const { data: cm } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).maybeSingle();
    expect(cm).toBeNull();
  });

  it("aceita mov S sem custo (operacional não afetado)", async () => {
    const produtoId = await novoProduto("op");
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
      p_origem_id: null, p_custo_unitario: 5, p_motivo: "base",
    });
    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 3, p_origem_tipo: "venda_manual",
      p_origem_id: null, p_custo_unitario: null, p_motivo: "saida sem custo",
    });
    expect(error).toBeNull();
  });
});

describe("P110 — estorno reverte custo médio", () => {
  it("custo 5 → entrada qty a custo 8 (vira 8) → estornar essa entrada → volta a 5", async () => {
    const produtoId = await novoProduto("estorno");
    // base: custo 5 com 10 un
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
      p_origem_id: null, p_custo_unitario: 5, p_motivo: "base 5",
    });
    // entrada que move pra 8: (10*5 + 10*15)/20 = 10 — usamos custo 15 pra média virar 10
    const { data: movE } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "nf_compra",
      p_origem_id: null, p_custo_unitario: 15, p_motivo: "entrada 15",
    });
    const { data: cmDepois } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).single();
    expect(Number(cmDepois?.custo_medio)).toBeCloseTo(10, 3);

    // estorna a entrada de 15 → custo médio volta ao anterior (5)
    const { error: eEst } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 10, p_origem_tipo: "estorno",
      p_origem_id: movE as unknown as string, p_estorno_de: movE as unknown as string,
      p_custo_unitario: null, p_motivo: "estorno entrada 15",
    });
    expect(eEst).toBeNull();
    const { data: cmFinal } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).single();
    expect(Number(cmFinal?.custo_medio)).toBeCloseTo(5, 3);
  });
});
