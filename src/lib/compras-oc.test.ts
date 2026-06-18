import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { findOrCreateOcAberta } from "./compras-oc";

/**
 * Builder fluente fake de siso_ordens_compra. select/eq/limit/insert devolvem o
 * próprio builder; maybeSingle (find + re-select) e single (insert) são terminais.
 */
function makeSb(opts: {
  existingId?: string | null;
  insertError?: { code: string; message: string };
  insertId?: string;
  reselectId?: string | null;
}) {
  let maybeCalls = 0;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    eq: () => b,
    limit: () => b,
    insert: () => b,
    maybeSingle: async () => {
      maybeCalls++;
      if (maybeCalls === 1) {
        return { data: opts.existingId ? { id: opts.existingId } : null, error: null };
      }
      return { data: opts.reselectId ? { id: opts.reselectId } : null, error: null };
    },
    single: async () =>
      opts.insertError
        ? { data: null, error: opts.insertError }
        : { data: { id: opts.insertId }, error: null },
  });
  return { from: () => b };
}

const args = { fornecedor: "Tiger", galpaoId: "g1", empresaId: null, observacao: "x" };

describe("findOrCreateOcAberta", () => {
  it("OC aberta já existe → reaproveita, não insere", async () => {
    const id = await findOrCreateOcAberta(makeSb({ existingId: "oc-existe" }) as never, args);
    expect(id).toBe("oc-existe");
  });

  it("não existe → cria e retorna o id novo", async () => {
    const id = await findOrCreateOcAberta(
      makeSb({ existingId: null, insertId: "oc-nova" }) as never,
      args,
    );
    expect(id).toBe("oc-nova");
  });

  it("corrida 23505 (índice único disparou) → re-seleciona a vencedora", async () => {
    const id = await findOrCreateOcAberta(
      makeSb({
        existingId: null,
        insertError: { code: "23505", message: "dup" },
        reselectId: "oc-vencedora",
      }) as never,
      args,
    );
    expect(id).toBe("oc-vencedora");
  });

  it("fornecedor vazio → null (não cria OC sem fornecedor)", async () => {
    const id = await findOrCreateOcAberta(makeSb({}) as never, { ...args, fornecedor: "" });
    expect(id).toBeNull();
  });
});
