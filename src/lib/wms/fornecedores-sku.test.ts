import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => buildSb() }));

/**
 * Simula as 2 queries de listarFornecedoresPorSkus:
 *  1. siso_produtos              .select("id, sku").in("sku", skus)
 *  2. siso_produto_fornecedores  .select(...).in("produto_id", ids).eq("ativo", true).order("preferencial", desc)
 * FILTRO-X tem 2 vínculos (Tiger preferencial + Bosch). SEM-CADASTRO não existe em siso_produtos.
 */
function buildSb() {
  return {
    from: (table: string) => {
      if (table === "siso_produtos") {
        return {
          select: () => ({
            in: async () => ({
              data: [{ id: "p-filtro", sku: "FILTRO-X" }],
              error: null,
            }),
          }),
        };
      }
      if (table === "siso_produto_fornecedores") {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      produto_id: "p-filtro",
                      fornecedor_id: "f-tiger",
                      custo_unitario: 12,
                      lead_time_dias_medio: 7,
                      qty_minima_pedido: 10,
                      multiplo_compra: 1,
                      preferencial: true,
                      fornecedor: { nome: "Tiger" },
                    },
                    {
                      produto_id: "p-filtro",
                      fornecedor_id: "f-bosch",
                      custo_unitario: 15,
                      lead_time_dias_medio: 3,
                      qty_minima_pedido: 1,
                      multiplo_compra: 1,
                      preferencial: false,
                      fornecedor: { nome: "Bosch" },
                    },
                  ],
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

import { listarFornecedoresPorSkus } from "./fornecedores-sku";

describe("listarFornecedoresPorSkus", () => {
  it("SKU com 2 vínculos → origem cadastro, preferencial primeiro, com preço/lead", async () => {
    const m = await listarFornecedoresPorSkus(["FILTRO-X", "SEM-CADASTRO"]);

    const filtro = m.get("FILTRO-X")!;
    expect(filtro.origem).toBe("cadastro");
    expect(filtro.opcoes).toHaveLength(2);
    expect(filtro.opcoes[0]).toMatchObject({
      nome: "Tiger",
      preferencial: true,
      custo_unitario: 12,
      lead_time_dias_medio: 7,
    });
    expect(filtro.opcoes[1].nome).toBe("Bosch");
  });

  it("SKU sem vínculo → origem prefixo, 1 opção do mapa, sem fornecedorId", async () => {
    const m = await listarFornecedoresPorSkus(["FILTRO-X", "SEM-CADASTRO"]);

    const sem = m.get("SEM-CADASTRO")!;
    expect(sem.origem).toBe("prefixo");
    expect(sem.opcoes).toHaveLength(1);
    expect(sem.opcoes[0].fornecedorId).toBeNull();
    expect(sem.opcoes[0].qty_minima_pedido).toBe(1);
    expect(sem.opcoes[0].multiplo_compra).toBe(1);
    expect(typeof sem.opcoes[0].nome).toBe("string");
  });

  it("lista vazia → mapa vazio (não bate no banco)", async () => {
    const m = await listarFornecedoresPorSkus([]);
    expect(m.size).toBe(0);
  });
});
