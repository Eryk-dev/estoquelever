import { describe, it, expect } from "vitest";
import { computeStatusCompra } from "./compras-manuais";

describe("computeStatusCompra", () => {
  it("nada recebido → comprado", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 0 },
        { qty_comprada: 3, qty_recebida: 0 },
      ]),
    ).toBe("comprado");
  });

  it("parte recebida → parcial", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 2 },
        { qty_comprada: 3, qty_recebida: 0 },
      ]),
    ).toBe("parcial");
  });

  it("um item completo e outro pendente → parcial", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 5 },
        { qty_comprada: 3, qty_recebida: 0 },
      ]),
    ).toBe("parcial");
  });

  it("tudo recebido → recebido", () => {
    expect(
      computeStatusCompra([
        { qty_comprada: 5, qty_recebida: 5 },
        { qty_comprada: 3, qty_recebida: 3 },
      ]),
    ).toBe("recebido");
  });

  it("lista vazia → comprado (fallback defensivo)", () => {
    expect(computeStatusCompra([])).toBe("comprado");
  });
});
