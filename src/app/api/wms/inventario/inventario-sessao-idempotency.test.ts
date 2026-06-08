import { describe, it, expect, vi } from "vitest";

// A rota usa requireWarehouseAccess (verificado em inventario/route.ts:49); mockamos ok.
vi.mock("@/lib/wms/auth", () => ({
  requireAuth: async () => ({ ok: true, user: { id: "u1" } }),
  requireWarehouseAccess: async () => ({ ok: true, user: { id: "u1" } }),
}));

const criarSessaoMock = vi.fn<(...args: unknown[]) => Promise<string>>(() =>
  Promise.resolve("sessao-1"),
);
vi.mock("@/lib/wms/inventario", () => ({
  criarSessao: (...args: unknown[]) => criarSessaoMock(...args),
}));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/inventario", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/wms/inventario — idempotency_key", () => {
  it("repassa idempotency_key do body pra criarSessao e responde 201 com o id", async () => {
    const res = await POST(
      makeReq({
        tipo: "cycle_count",
        galpao_id: "g1",
        idempotency_key: "key-abc",
        localizacoes: [{ localizacao_id: "loc1" }],
      }) as never,
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("sessao-1");
    expect(criarSessaoMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "key-abc" }),
    );
  });
});
