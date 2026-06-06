import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { reservarAtomico } from "../../src/lib/wms/reservas";

const sb = createServiceClient();
const SKU = `TEST-INT-RES-IDEMP-${Math.random().toString(36).slice(2, 8)}`;
const PEDIDO = `int-res-idemp-${Date.now()}`;
let produtoId: string, galpaoId: string, locId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-02")
    .single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Reservas idemp test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 10,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: null,
    p_motivo: "seed",
  });
});

describe("reservarAtomico — dedup R viva por (pedido,produto) (P003)", () => {
  it("duas chamadas pro mesmo (pedido,produto,tripla) → 1 R viva, reservado não dobra", async () => {
    const tripla = { produto_id: produtoId, galpao_id: galpaoId, localizacao_id: locId };

    const id1 = await reservarAtomico({ tripla, qty: 5, pedido_id: PEDIDO, ttl_horas: 1 });
    const id2 = await reservarAtomico({ tripla, qty: 5, pedido_id: PEDIDO, ttl_horas: 1 });

    expect(id2).toBe(id1);

    const { count } = await sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", PEDIDO)
      .eq("produto_id", produtoId);
    expect(count).toBe(1);

    const { data: est } = await sb
      .from("siso_estoque")
      .select("reservado")
      .eq("produto_id", produtoId)
      .single();
    expect(Number(est?.reservado)).toBe(5); // não 10
  });
});
