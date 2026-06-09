import { describe, it, expect, vi } from "vitest";

// session válida + permissão liberada (a rota usa userCanAny — verificado em route.ts:31/98)
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Op" }),
}));
vi.mock("@/lib/permissions", () => ({
  userCanAny: () => true,
}));
// vi.mock é hoisted; o spy precisa viver em vi.hoisted pra estar inicializado
// quando a factory roda.
const { receberSpy } = vi.hoisted(() => ({
  receberSpy: vi.fn(async () => ({
    oc_id: "oc1",
    itens_recebidos: 1,
    pendencias_criadas: [],
    oc_fechada: false,
    divergencias: [],
  })),
}));
vi.mock("@/lib/wms/receber-oc", () => ({ receberItensViaOC: receberSpy }));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/receber/oc/oc1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: "oc1" }) };

describe("POST /api/wms/receber/oc/[id] — loc por item + entrada direta + NF", () => {
  it("repassa entrada_direta, nf_referencia e localizacao_destino_id por item pra lib", async () => {
    const res = await POST(
      makeReq({
        itens: [{ item_id: "i1", qty_real: 3, localizacao_destino_id: "loc1" }],
        entrada_direta: true,
        nf_referencia: "NF-1",
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
        ocId: "oc1",
        entrada_direta: true,
        nf_referencia: "NF-1",
      }),
    );
    const itens = arg.itens as Array<Record<string, unknown>>;
    expect(itens[0]).toEqual(
      expect.objectContaining({ item_id: "i1", qty_real: 3, localizacao_destino_id: "loc1" }),
    );
  });
});
