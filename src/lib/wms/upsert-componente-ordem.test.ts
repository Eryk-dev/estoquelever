import { describe, it, expect, vi } from "vitest";

const calls: string[] = [];

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { eh_kit: false, ativo: true } }) }),
      }),
      update: () => ({ eq: async () => { calls.push(`update:${table}`); return { error: null }; } }),
      upsert: async () => { calls.push(`upsert:${table}`); return { error: null }; },
    }),
  };
  return { createServiceClient: () => client };
});

import { upsertComponente } from "./kits";

describe("upsertComponente — ordem componente antes de eh_kit", () => {
  it("insere a linha de componente ANTES de marcar eh_kit=true", async () => {
    calls.length = 0;
    await upsertComponente({ kit_produto_id: "k1", componente_produto_id: "c1", quantidade: 2 });
    const idxUpsert = calls.indexOf("upsert:siso_produto_kits");
    const idxUpdate = calls.indexOf("update:siso_produtos");
    expect(idxUpsert).toBeGreaterThanOrEqual(0);
    expect(idxUpdate).toBeGreaterThan(idxUpsert);
  });
});
