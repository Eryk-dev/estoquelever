import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { criarReservasRotaAtomico } from "../../src/lib/webhook-processor-wms";

const sb = createServiceClient();
const SKU_A = `TEST-INT-AON-A-${Math.random().toString(36).slice(2, 6)}`;
const SKU_B = `TEST-INT-AON-B-${Math.random().toString(36).slice(2, 6)}`;
const PEDIDO = `int-aon-${Date.now()}`;
let prodA: string, prodB: string, galpaoId: string, locId: string, locVazia: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-02").single();
  locId = l!.id;
  const { data: lv } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-03").single();
  locVazia = lv!.id;
  const mk = async (sku: string) => {
    const { data } = await sb.from("siso_produtos").insert({ sku, descricao: sku, ativo: true }).select("id").single();
    return data!.id as string;
  };
  prodA = await mk(SKU_A);
  prodB = await mk(SKU_B);
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodA, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial",
    p_origem_id: null, p_custo_unitario: null, p_motivo: "seed",
  });
});

describe("criarReservasRotaAtomico — all-or-nothing (P085)", () => {
  it("falha da 2ª reserva → throw e nenhuma R sobrevive (rollback)", async () => {
    const rotas = [
      { produto_id: prodA, galpao_id: galpaoId, localizacao_id: locId, qty: 1 },
      { produto_id: prodB, galpao_id: galpaoId, localizacao_id: locVazia, qty: 1 },
    ];

    await expect(
      criarReservasRotaAtomico({ pedidoId: PEDIDO, rotas }),
    ).rejects.toThrow();

    const { data: rs } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", PEDIDO);
    const ids = (rs ?? []).map((r) => r.id as string);
    if (ids.length > 0) {
      const { data: ls } = await sb.from("siso_movimentacoes").select("estorno_de").in("estorno_de", ids).eq("tipo", "L");
      const liberadas = new Set((ls ?? []).map((l) => l.estorno_de));
      const vivas = ids.filter((id) => !liberadas.has(id));
      expect(vivas).toEqual([]);
    }

    const { data: estA } = await sb.from("siso_estoque").select("reservado").eq("produto_id", prodA).single();
    expect(Number(estA?.reservado)).toBe(0);
  });
});
