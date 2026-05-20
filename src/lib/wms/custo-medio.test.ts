import { describe, it, expect } from "vitest";
import { calcularNovoCustoMedio } from "./custo-medio";

describe("calcularNovoCustoMedio", () => {
  it("primeira entrada absoluta (saldo zero, custo zero) → custo da entrada", () => {
    expect(calcularNovoCustoMedio(0, 0, 10, 15.5)).toBe(15.5);
  });
  it("entrada normal com saldo positivo → média ponderada", () => {
    expect(calcularNovoCustoMedio(10, 15.5, 5, 20)).toBeCloseTo(17.0, 2);
  });
  it("entrada após saldo global zero (mas custo médio guardado) → vira custo da entrada", () => {
    expect(calcularNovoCustoMedio(0, 17.0, 8, 12)).toBe(12);
  });
  it("entrada com custo zero → reduz média ponderada", () => {
    expect(calcularNovoCustoMedio(10, 20, 10, 0)).toBe(10);
  });
  it("mesma média se custos iguais", () => {
    expect(calcularNovoCustoMedio(50, 25, 50, 25)).toBe(25);
  });
});
