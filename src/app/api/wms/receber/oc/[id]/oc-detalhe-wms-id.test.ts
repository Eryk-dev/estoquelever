import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Op" }),
}));
vi.mock("@/lib/permissions", () => ({
  userCanAny: () => true,
}));
vi.mock("@/lib/wms/receber-oc", () => ({ receberItensViaOC: vi.fn() }));

vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => buildSb() }));

/**
 * Simulates the 4 chained Supabase calls in the GET handler (in order):
 *  1. siso_ordens_compra  .select(...).eq("id", id).single()
 *  2. siso_pedido_itens   .select(...).eq("ordem_compra_id", id)
 *  3. siso_produtos       .select("id, sku").in("sku", skus)
 *  4. siso_fornecedores   .select("id").ilike("nome", fornecedor).eq("ativo", true).limit(1)
 */
function buildSb() {
  return {
    from: (table: string) => {
      if (table === "siso_ordens_compra") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: "oc-1",
                  fornecedor: "Delphi",
                  galpao_id: "g1",
                  status: "comprado",
                  observacao: null,
                  siso_galpoes: { nome: "CWB" },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "siso_pedido_itens") {
        return {
          select: () => ({
            eq: async () => ({
              data: [
                {
                  id: "item-1",
                  sku: "ABC",
                  descricao: "Peça ABC",
                  imagem_url: null,
                  compra_quantidade_solicitada: 5,
                  compra_quantidade_recebida: 2,
                  produto_id: "tiny-999",
                },
              ],
              error: null,
            }),
          }),
        };
      }
      if (table === "siso_produtos") {
        return {
          select: () => ({
            in: async () => ({
              data: [{ id: "uuid-abc", sku: "ABC" }],
              error: null,
            }),
          }),
        };
      }
      if (table === "siso_fornecedores") {
        return {
          select: () => ({
            ilike: () => ({
              eq: () => ({
                limit: async () => ({
                  data: [{ id: "forn-1" }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({}) };
    },
  };
}

import { GET } from "./route";

const ctx = { params: Promise.resolve({ id: "oc-1" }) };

describe("GET /api/wms/receber/oc/[id] — produto_wms_id e fornecedor_id", () => {
  it("retorna 200 com produto_wms_id resolvido via sku e fornecedor_id resolvido via nome", async () => {
    const req = new Request("http://x/api/wms/receber/oc/oc-1") as never;
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();

    // produto_wms_id deve ser o uuid de siso_produtos
    expect(json.itens).toHaveLength(1);
    expect(json.itens[0].produto_wms_id).toBe("uuid-abc");

    // fornecedor_id deve ser o id de siso_fornecedores
    expect(json.oc.fornecedor_id).toBe("forn-1");
  });
});
