import { describe, it, expect, beforeEach, vi } from "vitest";

// Guarda anti-duplo-clique por idempotency_key (substitui o limite P055 de 1/dia).
// Mockamos só a fronteira do Supabase; a lógica de criarSessao é o que está sob teste.
let scenario: "novo" | "conflito" = "novo";
const calls = { sessoesInsert: [] as Record<string, unknown>[], locsInsert: 0 };

vi.mock("@/lib/supabase-server", () => {
  const sessoesTable = {
    insert: (payload: Record<string, unknown>) => ({
      select: () => ({
        single: async () => {
          calls.sessoesInsert.push(payload);
          if (scenario === "conflito") {
            return {
              data: null,
              error: { code: "23505", message: "duplicate key uq_inv_sessao_idempotency" },
            };
          }
          return { data: { id: "sessao-nova" }, error: null };
        },
      }),
    }),
    // lookup idempotente: .select("id").eq("idempotency_key", k).single()
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { id: "sessao-existente" }, error: null }),
      }),
    }),
  };
  const locsTable = {
    insert: async () => {
      calls.locsInsert += 1;
      return { error: null };
    },
  };
  const client = {
    from: (t: string) =>
      t === "siso_inventario_sessoes" ? sessoesTable : locsTable,
  };
  return { createServiceClient: () => client };
});

import { criarSessao } from "./inventario";

describe("criarSessao — guarda anti-duplo-clique (idempotency_key)", () => {
  beforeEach(() => {
    calls.sessoesInsert = [];
    calls.locsInsert = 0;
  });

  it("cria sessão nova e grava a idempotency_key", async () => {
    scenario = "novo";
    const id = await criarSessao({
      tipo: "cycle_count",
      galpao_id: "g1",
      criada_por: "u1",
      idempotencyKey: "key-abc",
      localizacoes: [{ localizacao_id: "loc1" }],
    });
    expect(id).toBe("sessao-nova");
    expect(calls.sessoesInsert[0]).toMatchObject({ idempotency_key: "key-abc" });
    expect(calls.locsInsert).toBe(1);
  });

  it("no duplo-clique (mesma key → 23505) devolve a sessão já criada, sem erro e sem duplicar locs", async () => {
    scenario = "conflito";
    const id = await criarSessao({
      tipo: "cycle_count",
      galpao_id: "g1",
      criada_por: "u1",
      idempotencyKey: "key-abc",
      localizacoes: [{ localizacao_id: "loc1" }],
    });
    expect(id).toBe("sessao-existente");
    expect(calls.locsInsert).toBe(0);
  });
});
