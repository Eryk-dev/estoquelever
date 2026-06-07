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
    .insert({ sku: `TEST-PICK-IDEMP-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("wms_pick_item_atomico ramo sem-reserva + p_idempotency_key", () => {
  it("2 chamadas com mesma key baixam só 1 vez (saldo não dobra)", async () => {
    const key = crypto.randomUUID();
    const args = {
      p_reserva_id: null, p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty: 3, p_pedido_id: "999000111", p_empresa_vendedora_id: empresaId,
      p_idempotency_key: key,
    };
    const r1 = await sb.rpc("wms_pick_item_atomico", args);
    expect(r1.error).toBeNull();
    const r2 = await sb.rpc("wms_pick_item_atomico", args);
    expect(r2.error).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(7); // 10 - 3 (só uma vez)
  });
});
