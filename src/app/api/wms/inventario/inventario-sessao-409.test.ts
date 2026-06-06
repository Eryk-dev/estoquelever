import { describe, it, expect, vi } from "vitest";

// A rota usa requireWarehouseAccess (verificado em inventario/route.ts:49); mockamos ok.
vi.mock("@/lib/wms/auth", () => ({
  requireAuth: async () => ({ ok: true, user: { id: "u1" } }),
  requireWarehouseAccess: async () => ({ ok: true, user: { id: "u1" } }),
}));

// criarSessao lança a MESMA Error de domínio que o Step 3 fará (P055).
vi.mock("@/lib/wms/inventario", () => ({
  criarSessao: vi.fn(async () => {
    throw new Error("Já existe sessão de inventário para este galpão hoje");
  }),
}));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/inventario", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/wms/inventario — sessão duplicada vira 409", () => {
  it("responde 409 (não 400/500) e REVELA a mensagem de domínio quando criarSessao lança o erro de duplicada", async () => {
    const res = await POST(
      makeReq({
        tipo: "cycle_count",
        galpao_id: "g1",
        localizacoes: [{ localizacao_id: "loc1" }],
      }) as never,
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    // wmsErrorResponse revela message em 4xx → não pode vir "internal_error".
    expect(String(json.error)).not.toBe("internal_error");
    expect(String(json.error)).toMatch(/já existe sessão de inventário para este galpão hoje/i);
  });
});
