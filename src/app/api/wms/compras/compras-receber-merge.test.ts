import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "T" }),
}));
vi.mock("@/lib/permissions", () => ({ userCan: () => true }));
vi.mock("@/lib/sku-fornecedor", () => ({ getFornecedorBySku: () => null }));
vi.mock("@/lib/wms/compras-manuais", () => ({
  listarComprasManuais: async (filtro: string) =>
    filtro === "pendentes"
      ? [
          {
            id: "m1",
            status: "comprado",
            observacao: null,
            criado_em: "2026-06-02T00:00:00Z",
            recebido_em: null,
            galpao_id: "g1",
            fornecedor: { id: "f1", nome: "Delphi" },
            empresa: { id: "e1", nome: "NetAir" },
            itens: [
              {
                id: "mi1",
                produto_id: "p1",
                sku: "X",
                descricao: "x",
                qty_comprada: 3,
                qty_recebida: 0,
                custo_unitario: 10,
              },
            ],
          },
        ]
      : [],
}));

vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => buildSb() }));

function buildSb() {
  return {
    from: (table: string) => {
      if (table === "siso_ordens_compra") {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = self;
        chain.in = self;
        chain.eq = self;
        chain.order = async () => ({
          data: [
            {
              id: "oc1",
              fornecedor: "Delphi",
              galpao_id: "g1",
              status: "comprado",
              created_at: "2026-06-01T00:00:00Z",
              siso_galpoes: { nome: "CWB" },
            },
          ],
          error: null,
        });
        return chain;
      }
      if (table === "siso_pedido_itens") {
        return {
          select: (_sel: string, opts?: { count?: string; head?: boolean }) => {
            // count/head path (fetchCounts) returns a thenable resolving {count,error}
            if (opts?.head) {
              const r = { count: 0, error: null };
              return { eq: () => Promise.resolve(r), in: () => Promise.resolve(r) };
            }
            // data path: pendente-by-OC (fetchReceber) and bloqueados (fetchCounts)
            return {
              in: async () => ({
                data: [
                  {
                    ordem_compra_id: "oc1",
                    compra_quantidade_solicitada: 5,
                    compra_quantidade_recebida: 0,
                  },
                ],
                error: null,
              }),
            };
          },
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) };
    },
  };
}

import { GET } from "./route";

describe("GET /api/wms/compras?tab=receber (unificado por documento)", () => {
  it("retorna grupos por fornecedor com docs OC + manual e origem", async () => {
    const req = new Request("http://x/api/wms/compras?tab=receber") as never;
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    const delphi = json.fornecedores.find(
      (f: { fornecedor: string }) => f.fornecedor === "Delphi",
    );
    expect(delphi).toBeTruthy();
    const origens = delphi.documentos.map((d: { origem: string }) => d.origem).sort();
    expect(origens).toEqual(["manual", "oc"]);
  });
});
