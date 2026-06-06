import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock: "Diversos" já existe; resto não. upsert com ignoreDuplicates não cria
// os que já existem. A contagem deve refletir isso deterministicamente.
const existentesPorNome = new Set<string>(["Diversos"]);

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      select: () => ({
        in: async (_col: string, nomes: string[]) => ({
          data: nomes.filter((n) => existentesPorNome.has(n)).map((nome) => ({ nome })),
        }),
      }),
      upsert: async (rows: Array<{ nome: string }>) => {
        for (const r of rows) existentesPorNome.add(r.nome);
        return { error: null };
      },
    }),
  };
  return { createServiceClient: () => client };
});

import { autoCriarFornecedoresDosPrefixosSku } from "./fornecedores";

describe("autoCriarFornecedoresDosPrefixosSku — contagem determinística", () => {
  beforeEach(() => { existentesPorNome.clear(); existentesPorNome.add("Diversos"); });

  it("conta o pré-existente como existente e o total bate com o PADRAO (11)", async () => {
    const r = await autoCriarFornecedoresDosPrefixosSku();
    expect(r.existentes).toBe(1);
    expect(r.criados).toBe(10);
    expect(r.criados + r.existentes).toBe(11);
  });

  it("2ª chamada não cria nada (todos já existem)", async () => {
    await autoCriarFornecedoresDosPrefixosSku();
    const r2 = await autoCriarFornecedoresDosPrefixosSku();
    expect(r2.criados).toBe(0);
    expect(r2.existentes).toBe(11);
  });
});
