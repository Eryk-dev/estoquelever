import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ id: "u1", nome: "T" }) }));
vi.mock("@/lib/permissions", () => ({ userCan: () => true }));
const { listarSpy } = vi.hoisted(() => ({
  listarSpy: vi.fn(async () => [
    { id: "m1", status: "comprado", observacao: null, criado_em: "2026-06-02T00:00:00Z", recebido_em: null,
      galpao_id: "g1", fornecedor: { id: "f1", nome: "Delphi" }, empresa: { id: "e1", nome: "NetAir" },
      itens: [{ id: "mi1", produto_id: "p1", sku: "X", descricao: "x", qty_comprada: 3, qty_recebida: 0, custo_unitario: 10 }] },
  ]),
}));
vi.mock("@/lib/wms/compras-manuais", () => ({ listarComprasManuais: listarSpy }));

import { GET } from "./route";

describe("GET /api/wms/compras-manuais/[id]", () => {
  it("retorna a compra manual pelo id", async () => {
    const res = await GET(new Request("http://x/api/wms/compras-manuais/m1") as never, {
      params: Promise.resolve({ id: "m1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.compra.id).toBe("m1");
    expect(json.compra.itens[0].sku).toBe("X");
  });
});
