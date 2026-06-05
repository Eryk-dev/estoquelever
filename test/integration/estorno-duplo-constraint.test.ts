import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let galpaoId: string;
let locId: string;
let movEId: string;
const SKU = `TEST-ESTORNO-UQ-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Estorno UNIQUE test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  // entrada base de 10 un (custo 5)
  const { data: mov } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
    p_origem_id: null, p_custo_unitario: 5, p_motivo: "base estorno",
  });
  movEId = mov as unknown as string;
});

describe("UNIQUE parcial uq_mov_estorno_unico", () => {
  it("aceita o 1º estorno e rejeita o 2º (mesma mov) com 23505", async () => {
    // 1º estorno: S de 10 com estorno_de=movEId → saldo 10 → 0
    const { error: e1 } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 10, p_origem_tipo: "estorno",
      p_origem_id: movEId, p_custo_unitario: null, p_estorno_de: movEId,
      p_motivo: "estorno 1",
    });
    expect(e1).toBeNull();

    // Repõe saldo pra 10 com OUTRA entrada — assim o 2º estorno NÃO bate no
    // guard de saldo insuficiente (P0001) e chega ao INSERT, onde o UNIQUE
    // parcial uq_mov_estorno_unico é o que precisa rejeitá-lo.
    const { error: eRepo } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
      p_origem_id: null, p_custo_unitario: 5, p_motivo: "repor saldo",
    });
    expect(eRepo).toBeNull();

    // 2º estorno do MESMO movEId — saldo cobre (10→0), passa o guard de saldo
    // e bate no UNIQUE → 23505.
    const { error: e2 } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 10, p_origem_tipo: "estorno",
      p_origem_id: movEId, p_custo_unitario: null, p_estorno_de: movEId,
      p_motivo: "estorno 2",
    });
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });
});
