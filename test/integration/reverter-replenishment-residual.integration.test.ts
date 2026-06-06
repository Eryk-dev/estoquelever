import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { reverterReplenishment } from "../../src/lib/wms/movimentacoes";

const sb = createServiceClient();
let galpaoId: string, locOrig: string, locDest: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: lo } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locOrig = lo!.id;
  const { data: ld } = await sb.from("siso_localizacoes").upsert({ galpao_id: galpaoId, codigo: `REPL-DEST-${RND}`, tipo: "picking", ativo: true }, { onConflict: "galpao_id,codigo" }).select("id").single();
  locDest = ld!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `REPLRES-${RND}`, descricao: "repl res", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("reverterReplenishment — estorno residual [P078]", () => {
  it("após estorno parcial de 3 de 5, reverter desfaz só as 2 restantes (sem erro qty_estornada>0)", async () => {
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locOrig, p_tipo: "E", p_quantidade: 5, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    const { data: repl } = await sb.rpc("wms_replenishment_intra_galpao", {
      p_galpao_id: galpaoId, p_localizacao_origem_id: locOrig, p_localizacao_destino_id: locDest,
      p_itens: [{ produto_id: prodId, qty: 5 }], p_usuario_id: usuarioId, p_observacoes: null, p_origem_id: null,
    });
    const origemId = (repl as { origem_id: string }).origem_id;
    const { data: movE } = await sb.from("siso_movimentacoes").select("id").eq("origem_id", origemId).eq("tipo", "E").eq("localizacao_id", locDest).single();
    const pE = await sb.rpc("wms_estornar_parcial_movimentacao", { p_mov_id: (movE as { id: string }).id, p_qty: 3, p_usuario_id: usuarioId, p_observacoes: "parcial 3" });
    expect(pE.error).toBeNull();
    const { data: movS } = await sb.from("siso_movimentacoes").select("id").eq("origem_id", origemId).eq("tipo", "S").eq("localizacao_id", locOrig).single();
    const pS = await sb.rpc("wms_estornar_parcial_movimentacao", { p_mov_id: (movS as { id: string }).id, p_qty: 3, p_usuario_id: usuarioId, p_observacoes: "parcial 3 S" });
    expect(pS.error).toBeNull();
    // o setup precisa ter de fato deixado um residual de 2 (qty_estornada=3 de 5)
    const { data: estE } = await sb.from("siso_movimentacoes").select("qty_estornada").eq("id", (movE as { id: string }).id).single();
    expect(Number((estE as { qty_estornada: number }).qty_estornada)).toBe(3);

    const r = await reverterReplenishment({ origem_id: origemId, usuario_id: usuarioId, motivo: "reverter residual" });
    expect(r.movsEstornadas).toBeGreaterThanOrEqual(1);
    const { data: eOrig } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locOrig).single();
    const { data: eDest } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locDest).single();
    expect(Number(eOrig?.saldo)).toBe(5);
    expect(Number(eDest?.saldo)).toBe(0);
  });
});
