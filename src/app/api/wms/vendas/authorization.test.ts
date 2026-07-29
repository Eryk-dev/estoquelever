import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  eqCalls: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/session", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from: () => {
      const query: Record<string, unknown> = {};
      for (const method of [
        "select",
        "or",
        "eq",
        "in",
        "is",
        "neq",
        "gte",
        "lte",
        "order",
        "range",
      ]) {
        query[method] = (...args: unknown[]) => {
          if (method === "eq") {
            mocks.eqCalls.push([String(args[0]), args[1]]);
          }
          return query;
        };
      }
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(
          resolve,
          reject,
        );
      return query;
    },
  }),
}));

import { GET } from "./route";

function request(query = "") {
  return new NextRequest(`http://localhost/api/wms/vendas${query}`);
}

function session(permissoes: string[]) {
  return {
    id: "vendedor-logado",
    nome: "Vendedor",
    cargo: "vendedor",
    cargos: ["vendedor"],
    roles: [],
    permissoes: new Set(permissoes),
    galpaoId: null,
  };
}

describe("GET /api/wms/vendas — escopo de vendedor", () => {
  beforeEach(() => {
    mocks.eqCalls.length = 0;
  });

  it.each([
    "?vendedor_id=__todos__",
    "?vendedor_id=outro-usuario",
  ])("ignora filtro privilegiado de vendedor puro: %s", async (query) => {
    mocks.getSessionUser.mockResolvedValue(
      session(["vendas.ver", "vendas.criar"]),
    );

    const response = await GET(request(query));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.eqCalls).toContainEqual([
      "vendedor_id",
      "vendedor-logado",
    ]);
    expect(mocks.eqCalls).not.toContainEqual([
      "vendedor_id",
      "outro-usuario",
    ]);
    expect(body.auto_filtro_meus).toBe(true);
  });

  it("permite que operador filtre outro vendedor", async () => {
    mocks.getSessionUser.mockResolvedValue(
      session(["vendas.ver", "vendas.criar", "separacao.executar"]),
    );

    const response = await GET(request("?vendedor_id=outro-usuario"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.eqCalls).toContainEqual(["vendedor_id", "outro-usuario"]);
    expect(body.auto_filtro_meus).toBe(false);
  });
});
