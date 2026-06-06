import { describe, it, expect, vi } from "vitest";

let custoHistorico: number | null = null;

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: custoHistorico === null ? null : { custo_medio: custoHistorico } }) }),
      }),
    }),
  };
  return { createServiceClient: () => client };
});

import { resolverCustoEntrada } from "./custo-fallback";

describe("resolverCustoEntrada", () => {
  it("usa o custo informado quando > 0", async () => {
    custoHistorico = 99;
    expect(await resolverCustoEntrada({ produto_id: "p1", custo_informado: 12 })).toBe(12);
  });

  it("cai pro custo médio histórico quando o informado é 0/ausente", async () => {
    custoHistorico = 7.5;
    expect(await resolverCustoEntrada({ produto_id: "p1", custo_informado: 0 })).toBe(7.5);
    expect(await resolverCustoEntrada({ produto_id: "p1", custo_informado: undefined })).toBe(7.5);
  });

  it("lança erro quando não há custo informado nem histórico (produto novo)", async () => {
    custoHistorico = null;
    await expect(
      resolverCustoEntrada({ produto_id: "p1", custo_informado: 0 }),
    ).rejects.toThrow(/custo unitário obrigatório/i);
  });
});
