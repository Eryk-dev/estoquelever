import { describe, it, expect } from "vitest";
import { calcularNecessidadeSkuPorGalpao } from "./compras-sourcing";

describe("calcularNecessidadeSkuPorGalpao", () => {
  it("neta por galpão e SOMA: CWB precisa 3 (0 livre, 0 trânsito), SP precisa 1 → 4", () => {
    const r = calcularNecessidadeSkuPorGalpao([
      { galpaoId: "cwb", demanda: 3, livre: 0, transito: 0 },
      { galpaoId: "sp", demanda: 1, livre: 0, transito: 0 },
    ]);
    expect(r.total).toBe(4);
  });

  it("OC de 3 chegando em CWB cobre CWB; SP segue precisando 1 → total 1 (NÃO zera SP)", () => {
    const r = calcularNecessidadeSkuPorGalpao([
      { galpaoId: "cwb", demanda: 3, livre: 0, transito: 3 },
      { galpaoId: "sp", demanda: 1, livre: 0, transito: 0 },
    ]);
    expect(r.total).toBe(1);
    expect(r.porGalpao).toContainEqual({ galpaoId: "cwb", necessidade: 0 });
    expect(r.porGalpao).toContainEqual({ galpaoId: "sp", necessidade: 1 });
  });

  it("excesso num galpão não compensa falta em outro (clamp por galpão)", () => {
    const r = calcularNecessidadeSkuPorGalpao([
      { galpaoId: "cwb", demanda: 1, livre: 5, transito: 0 }, // sobra 4, clampa 0
      { galpaoId: "sp", demanda: 3, livre: 0, transito: 0 },
    ]);
    expect(r.total).toBe(3);
  });

  it("over-receive (trânsito > demanda) não vira necessidade negativa", () => {
    const r = calcularNecessidadeSkuPorGalpao([
      { galpaoId: "cwb", demanda: 2, livre: 0, transito: 5 },
    ]);
    expect(r.total).toBe(0);
  });

  it("lista vazia → total 0", () => {
    const r = calcularNecessidadeSkuPorGalpao([]);
    expect(r).toEqual({ total: 0, porGalpao: [] });
  });
});
