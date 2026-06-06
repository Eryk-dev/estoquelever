import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { registrarContagemInline } from "../../src/lib/wms/contagem-inline";

const sb = createServiceClient();
let galpaoId: string, locId: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

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
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `CINLINE-${RND}`, descricao: "inline", ativo: true })
    .select("id")
    .single();
  prodId = p!.id;
  // saldo inicial 5
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 5,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: 8,
    p_motivo: "seed",
  });
});

describe("wms_contagem_inline_atomica via registrarContagemInline", () => {
  it("[RED] a RPC wms_contagem_inline_atomica existe (PGRST202 antes da migration)", async () => {
    const { error } = await sb.rpc("wms_contagem_inline_atomica", {
      p_produto_id: prodId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_qty_contada: 5,
      p_contada_por: usuarioId,
      p_sessao_id: "00000000-0000-0000-0000-000000000000",
      p_sku: null,
      p_pedido_id: null,
    });
    expect(error?.code).not.toBe("PGRST202");
    expect(error?.message ?? "").not.toMatch(/could not find the function|does not exist/i);
  });

  it("conta 8 (saldo 5): cria 1 mov ganho E 1 contagem E 1 divergência acoplados", async () => {
    const r = await registrarContagemInline({
      produto_id: prodId,
      galpao_id: galpaoId,
      localizacao_id: locId,
      qty_contada: 8,
      contada_por: usuarioId,
      sku: `CINLINE-${RND}`,
    });
    expect(r.delta).toBe(3);
    expect(r.mov_reconciliacao_id).not.toBeNull();
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", prodId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(est?.saldo)).toBe(8);
    const { count: movs } = await sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("produto_id", prodId)
      .in("origem_tipo", ["inventario_ganho", "inventario_perda"]);
    const { count: cont } = await sb
      .from("siso_inventario_contagens")
      .select("id", { count: "exact", head: true })
      .eq("produto_id", prodId);
    expect(movs).toBe(1);
    expect(cont).toBeGreaterThanOrEqual(1);
  });

  it("re-contar pra mesma qty é idempotente no saldo (delta 0, não duplica ganho)", async () => {
    const r2 = await registrarContagemInline({
      produto_id: prodId,
      galpao_id: galpaoId,
      localizacao_id: locId,
      qty_contada: 8,
      contada_por: usuarioId,
      sku: `CINLINE-${RND}`,
    });
    expect(r2.delta).toBe(0);
    expect(r2.mov_reconciliacao_id).toBeNull();
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", prodId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(est?.saldo)).toBe(8);
  });
});
