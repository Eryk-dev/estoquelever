import { describe, it, expect, vi } from "vitest";

// Sessão sempre válida com permissão compras.executar.
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Tester" }),
}));
vi.mock("@/lib/permissions", () => ({
  userCan: (_s: unknown, code: string) => code === "compras.executar",
}));
const { registrarEventosSpy } = vi.hoisted(() => ({
  registrarEventosSpy: vi.fn(async () => {}),
}));
vi.mock("@/lib/historico-service", () => ({
  registrarEventos: registrarEventosSpy,
}));

// createServiceClient chainable: fornecedor existe + update retorna 2 linhas.
const updateInSpy = vi.fn();
vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "siso_fornecedores") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({ data: [{ id: "f1" }], error: null }),
              }),
            }),
          }),
        };
      }
      // siso_pedido_itens
      return {
        update: (patch: unknown) => ({
          in: (col: string, ids: string[]) => {
            updateInSpy(patch, col, ids);
            return {
              select: async () => ({
                data: [
                  { id: "i1", pedido_id: "p1" },
                  { id: "i2", pedido_id: "p2" },
                ],
                error: null,
              }),
            };
          },
        }),
      };
    },
  }),
}));

import { PATCH } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/compras/itens/fornecedor", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH /api/wms/compras/itens/fornecedor", () => {
  it("troca fornecedor_oc de todos os item_ids e responde 200", async () => {
    const res = await PATCH(
      makeReq({ item_ids: ["i1", "i2"], fornecedor_oc: "Delphi" }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.atualizados).toBe(2);
    expect(updateInSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fornecedor_oc: "Delphi" }),
      "id",
      ["i1", "i2"],
    );
    expect(registrarEventosSpy).toHaveBeenCalled();
  });

  it("rejeita item_ids vazio com 400", async () => {
    const res = await PATCH(makeReq({ item_ids: [], fornecedor_oc: "X" }) as never);
    expect(res.status).toBe(400);
  });
});
