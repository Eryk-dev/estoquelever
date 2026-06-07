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
    .insert({ sku: `TEST-IDEMP-${Date.now()}`, descricao: "idemp", ativo: true }).select("id").single();
  prodId = p!.id;
  // saldo inicial
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 50, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("siso_movimentacoes.idempotency_key UNIQUE parcial", () => {
  it("rejeita 2ª mov com mesmo idempotency_key (23505)", async () => {
    const key = crypto.randomUUID();
    const ins1 = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 50, saldo_posterior: 49, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: key,
    });
    expect(ins1.error).toBeNull();
    const ins2 = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 49, saldo_posterior: 48, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: key,
    });
    expect(ins2.error?.code).toBe("23505");
  });

  it("permite múltiplas movs com idempotency_key NULL (legado)", async () => {
    const a = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 48, saldo_posterior: 47, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: null,
    });
    const b = await sb.from("siso_movimentacoes").insert({
      produto_id: prodId, galpao_id: galpaoId, localizacao_id: locId,
      tipo: "S", quantidade: 1, origem_tipo: "nf_venda",
      saldo_anterior: 47, saldo_posterior: 46, reservado_anterior: 0, reservado_posterior: 0,
      idempotency_key: null,
    });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });
});

describe("wms_inserir_movimentacao p_idempotency_key", () => {
  it("2ª chamada com mesma key é no-op (retorna a mesma mov, saldo não dobra)", async () => {
    const key = crypto.randomUUID();
    const { data: estA } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    const mov1 = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 2, p_origem_tipo: "nf_venda", p_idempotency_key: key, p_motivo: "idemp",
    });
    expect(mov1.error).toBeNull();
    const mov2 = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 2, p_origem_tipo: "nf_venda", p_idempotency_key: key, p_motivo: "idemp",
    });
    expect(mov2.error).toBeNull();
    expect(mov2.data).toBe(mov1.data); // mesma mov id
    const { data: estB } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(estB?.saldo)).toBe(Number(estA?.saldo) - 2); // baixou só 1 vez
  });

  // REGRESSÃO DE FIDELIDADE: a recriação da RPC NÃO pode alterar o custo médio.
  // Produto novo, custo médio começa do zero; duas entradas nf_compra com custos
  // distintos devem dar a média ponderada EXATA da fórmula original
  // (v_saldo_global * atual + qty * custo) / (v_saldo_global + qty).
  it("preserva o cálculo de custo médio ponderado (fidelidade coluna-a-coluna)", async () => {
    const { data: prodCusto } = await sb.from("siso_produtos")
      .insert({ sku: `TEST-CUSTO-${Date.now()}`, descricao: "custo", ativo: true }).select("id").single();
    const pc = prodCusto!.id as string;
    // NF de compra exige nota_fiscal_id — cria DUAS NFs distintas (uq_mov_recebimento_nf_id
    // bloqueia 2 nf_compra com a mesma NF p/ o mesmo produto+galpão — dedup de recebimento).
    const chave1 = String(Date.now()).padEnd(44, "0").slice(0, 44);
    const chave2 = String(Date.now() + 1).padEnd(44, "0").slice(0, 44);
    const { data: nf1 } = await sb.from("siso_notas_fiscais")
      .insert({ chave_acesso: chave1, numero: "1", serie: "1", tipo: "entrada" }).select("id").single();
    const { data: nf2 } = await sb.from("siso_notas_fiscais")
      .insert({ chave_acesso: chave2, numero: "2", serie: "1", tipo: "entrada" }).select("id").single();
    const nf1Id = nf1!.id as string;
    const nf2Id = nf2!.id as string;
    // 1ª entrada: 10 un @ R$ 5,00 → custo médio = 5,00
    const e1 = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: pc, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "nf_compra",
      p_custo_unitario: 5, p_nota_fiscal_id: nf1Id, p_motivo: "c1",
    });
    expect(e1.error).toBeNull();
    // 2ª entrada: 10 un @ R$ 7,00 → custo médio ponderado = (10*5 + 10*7)/20 = 6,00
    const e2 = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: pc, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 10, p_origem_tipo: "nf_compra",
      p_custo_unitario: 7, p_nota_fiscal_id: nf2Id, p_motivo: "c2",
    });
    expect(e2.error).toBeNull();
    const { data: cm } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", pc).single();
    expect(Number(cm?.custo_medio)).toBeCloseTo(6, 4);
  });
});
