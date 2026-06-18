import { describe, it, expect, vi } from "vitest";

let kitCount = 0;

// Mock do supabase pra controlar o count de siso_produto_kits por produto.
const sbMock = {
  from: () => ({
    select: () => ({
      eq: async () => ({ count: kitCount, error: null }),
    }),
  }),
} as never;

// Mocka as deps pesadas de sync-tiny (Tiny API/oauth/queue) pra o import não puxar env.
vi.mock("@/lib/tiny-api", () => ({
  getProdutoFull: vi.fn(),
  getProdutoCompleto: vi.fn(),
  buscarProdutoPorSku: vi.fn(),
}));
vi.mock("@/lib/tiny-oauth", () => ({ getValidTokenByEmpresa: vi.fn() }));
vi.mock("@/lib/tiny-queue", () => ({ runWithEmpresa: vi.fn() }));

import { resolverEhKitSync } from "./sync-tiny";

describe("resolverEhKitSync — eh_kit condicional à composição", () => {
  it("tipo K sem composição (count=0) → false", async () => {
    kitCount = 0;
    expect(await resolverEhKitSync(sbMock, "p1", "K")).toBe(false);
  });

  it("tipo K com composição (count>0) → true", async () => {
    kitCount = 2;
    expect(await resolverEhKitSync(sbMock, "p1", "K")).toBe(true);
  });

  it("tipo não-K → false (independe do count)", async () => {
    kitCount = 5;
    expect(await resolverEhKitSync(sbMock, "p1", "S")).toBe(false);
  });
});
