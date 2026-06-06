import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({
            data: null,
            error: { code: "23505", message: "duplicate key uq_inv_sessao_galpao_dia" },
          }),
        }),
      }),
    }),
  };
  return { createServiceClient: () => client };
});

import { criarSessao } from "./inventario";

describe("criarSessao — sessão duplicada por galpão+dia", () => {
  it("traduz 23505 em erro de domínio legível", async () => {
    await expect(
      criarSessao({
        tipo: "cycle_count", galpao_id: "g1", criada_por: "u1",
        localizacoes: [{ localizacao_id: "loc1" }],
      } as never),
    ).rejects.toThrow(/já existe sessão de inventário para este galpão hoje/i);
  });
});
