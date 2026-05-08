import { describe, it, expect } from "vitest";
import { validarTroca } from "./troca-sku";

describe("validarTroca", () => {
  it("rejeita troca pelo mesmo SKU", () => {
    expect(() =>
      validarTroca({ produto_original_id: "x", produto_substituto_id: "x" }),
    ).toThrow(/mesmo SKU/i);
  });

  it("aceita SKUs diferentes", () => {
    expect(() =>
      validarTroca({ produto_original_id: "a", produto_substituto_id: "b" }),
    ).not.toThrow();
  });
});
