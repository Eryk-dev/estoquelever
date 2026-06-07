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
    .insert({ sku: `TEST-RETRO-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
});

async function lancamentoRetroativo(qty: number) {
  const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: qty, p_origem_tipo: "lancamento_retroativo", p_custo_unitario: 10, p_motivo: "retro",
  });
  return (movId.data ?? movId) as string;
}

describe("wms_reconciliar_retroativo", () => {
  it("estorna a qty total quando saldo cobre (idempotente na 2ª = no-op)", async () => {
    const retroId = await lancamentoRetroativo(100);
    // p_compra_mov_id é só tag de rastreio (motivo/origem_detalhes); a RPC NÃO
    // valida existência da compra (isso fica na rota). Reusar retroId é seguro.
    const r1 = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: null,
    });
    expect(r1.error).toBeNull();
    expect((r1.data as { qty_estornada: number }).qty_estornada).toBe(100);
    // 2ª chamada (duplo-clique/reclique tardio): no-op idempotente
    const r2 = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: null,
    });
    expect(r2.error).toBeNull();
    expect((r2.data as { idempotente: boolean }).idempotente).toBe(true);
  });

  it("estorno PARCIAL: parte já vendida → estorna só o disponível (P147)", async () => {
    const retroId = await lancamentoRetroativo(70);
    // vende 50 do saldo → disponível 20
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 50, p_origem_tipo: "venda_manual", p_motivo: "vendeu",
    });
    const r = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: 20,
    });
    expect(r.error).toBeNull();
    expect((r.data as { qty_estornada: number }).qty_estornada).toBe(20);
  });

  // PROVA O CLAMP (não o pass-through do arg): p_qty_estorno=null e o que
  // decide a qty é o disponível atual. Retroativo 70, vende 50 → disponível 20.
  // Com arg null, qty_estornada SÓ pode ser 20 se o clamp ao disponível agir
  // (LEAST(COALESCE(null,70), 70, 20) = 20). Marca parcial=true.
  it("estorno PARCIAL com p_qty_estorno=null → clampa ao disponível (não ao arg)", async () => {
    const retroId = await lancamentoRetroativo(70);
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 50, p_origem_tipo: "venda_manual", p_motivo: "vendeu antes da reconciliação",
    });
    const r = await sb.rpc("wms_reconciliar_retroativo", {
      p_retroativo_mov_id: retroId, p_compra_mov_id: retroId, p_usuario_id: null, p_qty_estorno: null,
    });
    expect(r.error).toBeNull();
    const d = r.data as { qty_estornada: number; qty_original: number; parcial: boolean };
    expect(d.qty_estornada).toBe(20);   // o disponível (20) decidiu, não o arg (null→70)
    expect(d.qty_original).toBe(70);
    expect(d.parcial).toBe(true);
  });
});
