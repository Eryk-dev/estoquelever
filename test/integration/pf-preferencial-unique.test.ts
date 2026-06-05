import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let produtoId: string;
let f1Id: string;
let f2Id: string;
const SKU = `TEST-PF-UQ-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: p } = await sb
    .from("siso_produtos").insert({ sku: SKU, descricao: "PF UQ test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  const { data: f1 } = await sb
    .from("siso_fornecedores").insert({ nome: `FORN-A-${SKU}` }).select("id").single();
  f1Id = f1!.id;
  const { data: f2 } = await sb
    .from("siso_fornecedores").insert({ nome: `FORN-B-${SKU}` }).select("id").single();
  f2Id = f2!.id;
});

describe("UNIQUE parcial idx_pf_preferencial", () => {
  it("rejeita 2 vínculos preferencial+ativo do mesmo produto com 23505", async () => {
    const { error: e1 } = await sb.from("siso_produto_fornecedores").insert({
      produto_id: produtoId, fornecedor_id: f1Id, preferencial: true, ativo: true,
    });
    expect(e1).toBeNull();

    const { error: e2 } = await sb.from("siso_produto_fornecedores").insert({
      produto_id: produtoId, fornecedor_id: f2Id, preferencial: true, ativo: true,
    });
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });
});
