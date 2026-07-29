import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== "siso_pedidos") {
        throw new Error(`consulta inesperada após autorização: ${table}`);
      }
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: {
            id: "MAN-alheio",
            numero: "MAN-alheio",
            origem_pedido: "manual",
            nome_ecommerce: null,
            vendedor_id: "outro-usuario",
            vendedor_nome: "Outro vendedor",
          },
          error: null,
        }),
      };
      return query;
    },
  }),
}));

import { GET } from "./route";

describe("GET /api/wms/vendas/[id] — ownership", () => {
  it("nega pedido alheio a perfil autenticado sem permissão privilegiada", async () => {
    mocks.getSessionUser.mockResolvedValue({
      id: "usuario-sem-permissao",
      nome: "Usuário sem permissão",
      cargo: "",
      cargos: [],
      roles: [],
      permissoes: new Set(),
      galpaoId: null,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/wms/vendas/MAN-alheio"),
      { params: Promise.resolve({ id: "MAN-alheio" }) },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      erro: "Sem permissão (não é seu pedido)",
    });
  });
});
