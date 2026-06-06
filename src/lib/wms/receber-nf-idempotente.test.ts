import { describe, it, expect, vi } from "vitest";

// UUIDs v4-válidos (nibble de versão=4, variante=a) — assertUuidLike em ledger.ts
// exige v1-v5, então os placeholders aaaa.../bbbb... do plano são rejeitados antes
// da RPC. Mantêm-se distintos por byte inicial pra legibilidade.
const movExistente = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  produto_id: "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb",
  galpao_id: "cccccccc-cccc-4ccc-accc-cccccccccccc",
  localizacao_id: "dddddddd-dddd-4ddd-addd-dddddddddddd",
  tipo: "E", quantidade: 5, origem_tipo: "nf_compra", chave_acesso_nf: "X".repeat(44),
};
const NF_ID = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: (table: string) => ({
      select: () => ({
        match: () => ({ maybeSingle: async () => ({ data: { saldo: 0, reservado: 0 } }) }),
        // o recovery filtra por origem/produto/galpão + (chave OU nota_fiscal_id) e
        // termina em .maybeSingle(); o mock devolve a mov existente em qualquer chain de eq/is.
        eq: function () { return this; },
        is: function () { return this; },
        maybeSingle: async () => ({ data: movExistente }),
        single: async () => ({ data: movExistente }),
      }),
    }),
    rpc: async () => ({ data: null, error: { code: "23505", message: "duplicate key uq_mov_recebimento_nf_chave" } }),
  };
  return { createServiceClient: () => client };
});

import { inserirMovimentacao } from "./ledger";

describe("inserirMovimentacao — recebimento NF idempotente", () => {
  it("absorve 23505 pela assinatura chave_acesso_nf e devolve a mov E existente", async () => {
    const r = await inserirMovimentacao({
      tripla: { produto_id: movExistente.produto_id, galpao_id: movExistente.galpao_id, localizacao_id: movExistente.localizacao_id },
      tipo: "E", qty: 5, origem_tipo: "nf_compra",
      chave_acesso_nf: movExistente.chave_acesso_nf, custo_unitario: 8,
    });
    expect(r.id).toBe(movExistente.id);
  });

  it("absorve 23505 pela assinatura nota_fiscal_id (caminho compras/receber, sem chave)", async () => {
    const r = await inserirMovimentacao({
      tripla: { produto_id: movExistente.produto_id, galpao_id: movExistente.galpao_id, localizacao_id: movExistente.localizacao_id },
      tipo: "E", qty: 5, origem_tipo: "nf_compra",
      nota_fiscal_id: NF_ID, custo_unitario: 8,
    });
    expect(r.id).toBe(movExistente.id);
  });
});
