import { describe, it, expect, vi, beforeEach } from "vitest";

// UUIDs válidos (versão ∈ [1-5], variante ∈ [89ab]) — ledger.assertUuidLike é estrito.
const movOriginal = {
  id: "11111111-1111-4111-8111-111111111111",
  produto_id: "22222222-2222-4222-8222-222222222222",
  galpao_id: "33333333-3333-4333-8333-333333333333",
  localizacao_id: "44444444-4444-4444-8444-444444444444",
  tipo: "E", quantidade: 10, estorno_de: null, qty_estornada: 0,
  origem_tipo: "inventario_inicial",
};
const estornoExistente = {
  ...movOriginal,
  id: "99999999-9999-4999-8999-999999999999",
  tipo: "S",
  estorno_de: movOriginal.id,
};

// Quando true: o INSERT do estorno colide no UNIQUE (23505) e já existe um estorno
// gravado por outra transação concorrente — o caminho idempotente deve recuperá-lo.
let rpcShouldFail23505 = true;

vi.mock("@/lib/supabase-server", () => {
  // Builder encadeável fiel ao subset usado por estornarMovimentacao/inserirMovimentacao.
  // Distingue:
  //  - SELECT por id (original)              → single() devolve movOriginal
  //  - SELECT "id" por estorno_de (pré-guard)→ maybeSingle() devolve null (deixa chegar ao INSERT)
  //  - SELECT "*" por estorno_de (recovery)  → maybeSingle() devolve o estorno existente
  //  - SELECT em siso_estoque (.match)       → maybeSingle() devolve saldo cobrindo a saída
  const client = {
    from: (table: string) => {
      let selectCols = "*";
      let lastEqCol = "";
      const builder: Record<string, unknown> = {
        select: (cols?: string) => {
          selectCols = cols ?? "*";
          return builder;
        },
        eq: (col: string) => {
          lastEqCol = col;
          return builder;
        },
        match: () => builder,
        update: () => ({ eq: async () => ({ data: null, error: null }) }),
        single: async () => {
          if (table === "siso_movimentacoes" && lastEqCol === "id") {
            return { data: movOriginal, error: null };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => {
          if (table === "siso_estoque") {
            // saldo suficiente pra validarCoerencia não barrar a saída S de 10.
            return { data: { saldo: 10, reservado: 0 }, error: null };
          }
          if (table === "siso_movimentacoes" && lastEqCol === "estorno_de") {
            // pré-guard (select "id") vê null → flui pro INSERT.
            // recovery (select "*") vê o estorno já gravado pela corrida.
            if (selectCols === "id") return { data: null, error: null };
            return { data: estornoExistente, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    rpc: async () => {
      if (rpcShouldFail23505) {
        return {
          data: null,
          error: { code: "23505", message: "duplicate key uq_mov_estorno_unico" },
        };
      }
      return { data: estornoExistente.id, error: null };
    },
  };
  return { createServiceClient: () => client };
});

import { estornarMovimentacao } from "./ledger";

describe("estornarMovimentacao — 23505 idempotente", () => {
  beforeEach(() => { rpcShouldFail23505 = true; });

  it("quando o INSERT do estorno colide no unique, retorna a mov de estorno existente (não propaga erro)", async () => {
    const r = await estornarMovimentacao({
      mov_id: movOriginal.id,
      usuario_id: "55555555-5555-4555-8555-555555555555",
    });
    expect(r.id).toBe(estornoExistente.id);
  });
});
