import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

// [P078] RED→GREEN: wms_estornar_parcial_movimentacao estava quebrada desde o
// 3D (chamava wms_inserir_movimentacao com v_original.empresa_dona_id — coluna
// dropada — na assinatura antiga → 42703 em toda chamada). Antes da migration
// de reparo este teste falha com 42703 (empresa_dona_id); depois passa.

const sb = createServiceClient();
const RND = Math.random().toString(36).slice(2, 7);
let galpaoId: string, locId: string, usuarioId: string, prodId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  // Loc dedicada pra isolar o saldo deste teste (não compartilha com A-01-01).
  const { data: l } = await sb
    .from("siso_localizacoes")
    .upsert(
      { galpao_id: galpaoId, codigo: `ESTPARC-${RND}`, tipo: "picking", ativo: true },
      { onConflict: "galpao_id,codigo" },
    )
    .select("id")
    .single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `ESTPARC-${RND}`, descricao: "estorno parcial repair", ativo: true })
    .select("id")
    .single();
  prodId = p!.id;
});

describe("wms_estornar_parcial_movimentacao — repair [P078]", () => {
  it("estorna 3 de 5: error null, qty_estornada=3, saldo=2", async () => {
    // E qty=5 via RPC do ledger
    const { error: eErr } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_tipo: "E",
      p_quantidade: 5,
      p_origem_tipo: "inventario_inicial",
      p_origem_id: null,
      p_custo_unitario: 1,
      p_motivo: "seed estorno parcial",
    });
    expect(eErr).toBeNull();

    const { data: movE } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("produto_id", prodId)
      .eq("localizacao_id", locId)
      .eq("tipo", "E")
      .single();
    const movId = (movE as { id: string }).id;

    // Estorno parcial de 3 — antes do reparo isto erra com 42703 (empresa_dona_id)
    const res = await sb.rpc("wms_estornar_parcial_movimentacao", {
      p_mov_id: movId,
      p_qty: 3,
      p_usuario_id: usuarioId,
      p_observacoes: "parcial 3",
    });
    expect(res.error).toBeNull();

    const { data: orig } = await sb
      .from("siso_movimentacoes")
      .select("qty_estornada")
      .eq("id", movId)
      .single();
    expect(Number((orig as { qty_estornada: number }).qty_estornada)).toBe(3);

    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", prodId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(est?.saldo)).toBe(2);
  });
});
