import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let galpaoId: string;
let locId: string;
let nfId: string;
const SKU = `TEST-NF-DEDUP-${Math.random().toString(36).slice(2, 8)}`;
const CHAVE = `35${Math.random().toString().slice(2, 44)}`.padEnd(44, "0").slice(0, 44);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos").insert({ sku: SKU, descricao: "NF dedup test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  // NF canônica pra exercitar o índice por nota_fiscal_id (caminho compras/receber).
  const { data: nf } = await sb
    .from("siso_notas_fiscais")
    .insert({ chave_acesso: CHAVE, tipo: "entrada" })
    .select("id").single();
  nfId = nf!.id;
});

function entradaNf(extra?: Record<string, unknown>) {
  return sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 5, p_origem_tipo: "nf_compra",
    p_origem_id: crypto.randomUUID(), p_chave_acesso_nf: CHAVE,
    p_custo_unitario: 8, p_motivo: "recebimento NF", ...extra,
  });
}

describe("UNIQUE parcial uq_mov_recebimento_nf_chave (caminho /api/wms/receber)", () => {
  it("aceita a 1ª entrada da NF e rejeita a 2ª (mesma chave+produto+galpão) com 23505", async () => {
    const { error: e1 } = await entradaNf();
    expect(e1).toBeNull();

    const { error: e2 } = await entradaNf();
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");

    // saldo subiu só uma vez (5), custo médio recalculou só uma vez (8)
    const { data: est } = await sb
      .from("siso_estoque").select("saldo")
      .eq("produto_id", produtoId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(5);
    const { data: cm } = await sb
      .from("siso_custo_medio").select("custo_medio").eq("produto_id", produtoId).single();
    expect(Number(cm?.custo_medio)).toBeCloseTo(8, 3);
  });
});

describe("UNIQUE parcial uq_mov_recebimento_nf_id (caminho compras/receber — só nota_fiscal_id)", () => {
  it("rejeita a 2ª entrada da MESMA nota_fiscal_id (sem chave) com 23505", async () => {
    // produto novo pra isolar do describe anterior; entradas SEM chave, SÓ nota_fiscal_id.
    const { data: p2 } = await sb
      .from("siso_produtos").insert({ sku: `${SKU}-NFID`, descricao: "NF id dedup", ativo: true })
      .select("id").single();
    const produto2 = p2!.id;
    const base = {
      p_produto_id: produto2, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 5, p_origem_tipo: "nf_compra",
      p_origem_id: crypto.randomUUID(), p_nota_fiscal_id: nfId,
      p_custo_unitario: 8, p_motivo: "recebimento via nota_fiscal_id",
    };
    const { error: e1 } = await sb.rpc("wms_inserir_movimentacao", base);
    expect(e1).toBeNull();
    const { error: e2 } = await sb.rpc("wms_inserir_movimentacao", {
      ...base, p_origem_id: crypto.randomUUID(),
    });
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });
});
