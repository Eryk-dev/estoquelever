import { describe, it, expect, vi } from "vitest";

// Sessão válida + permissão liberada (a rota usa userCan("compras.executar"))
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Op" }),
}));
vi.mock("@/lib/permissions", () => ({
  userCan: () => true,
  userCanAny: () => true,
}));
// vi.mock é hoisted; o spy precisa viver em vi.hoisted pra estar inicializado
// quando a factory roda.
const { receberSpy } = vi.hoisted(() => ({
  receberSpy: vi.fn(async () => ({
    movs_geradas: 1,
    status: "recebido" as const,
    pendencia_ids: [],
    mov_ids: ["m1"],
  })),
}));
vi.mock("@/lib/wms/compras-manuais", () => ({ receberCompraManual: receberSpy }));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/compras-manuais/m1/receber", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: "m1" }) };

describe("POST /api/wms/compras-manuais/[id]/receber — loc por item + entrada direta", () => {
  it("repassa entrada_direta e localizacao_destino_id por item pra lib", async () => {
    const res = await POST(
      makeReq({
        itens: [{ item_id: "i1", qty_recebida: 2, localizacao_destino_id: "loc1" }],
        entrada_direta: true,
      }) as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(receberSpy).toHaveBeenCalledTimes(1);
    const arg = (receberSpy.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(arg).toEqual(
      expect.objectContaining({
        compra_id: "m1",
        entrada_direta: true,
      }),
    );
    const itens = arg.itens as Array<Record<string, unknown>>;
    expect(itens[0]).toEqual(
      expect.objectContaining({ item_id: "i1", qty_recebida: 2, localizacao_destino_id: "loc1" }),
    );
  });
});
