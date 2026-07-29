import { describe, expect, it } from "vitest";
import {
  agregarSolicitacaoPorProduto,
  produtoTemCobertura,
} from "./vendas-cobertura";

describe("cobertura agregada de linhas de venda", () => {
  it("soma SKU repetido antes de comparar com o saldo", () => {
    const agregadas = agregarSolicitacaoPorProduto([
      { produtoId: "produto-1", quantidade: 4 },
      { produtoId: "produto-1", quantidade: 4 },
      { produtoId: "produto-2", quantidade: 2 },
    ]);

    expect(agregadas.get("produto-1")).toEqual({
      quantidade: 8,
      linhas: 2,
    });
    expect(produtoTemCobertura(agregadas.get("produto-1"), 5)).toBe(false);
    expect(produtoTemCobertura(agregadas.get("produto-1"), 8)).toBe(true);
  });
});
