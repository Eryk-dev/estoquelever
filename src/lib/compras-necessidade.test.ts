import { describe, it, expect } from "vitest";
import { calcularNecessidadeLiquida } from "./compras-necessidade";

describe("calcularNecessidadeLiquida", () => {
  it("déficit simples: precisa 5, tem 2 livre, nada a caminho → comprar 3", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 2, emTransito: 0 });
    expect(r.necessidadeLiquida).toBe(3);
  });

  it("estoque livre cai de 2 pra 1 (pedido de 1un consumiu) → necessidade sobe pra 4", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 1, emTransito: 0 });
    expect(r.necessidadeLiquida).toBe(4);
  });

  it("já comprou 3 e nada foi consumido (livre 2) → necessidade 0", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 2, emTransito: 3 });
    expect(r.necessidadeLiquida).toBe(0);
  });

  it("já comprou 3 mas 1 livre foi consumido → necessidade 1 reaparece", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 1, emTransito: 3 });
    expect(r.necessidadeLiquida).toBe(1);
  });

  it("dois pedidos (8) com 3 já a caminho, 0 livre → comprar 5 (não sub-compra)", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 8, estoqueLivre: 0, emTransito: 3 });
    expect(r.necessidadeLiquida).toBe(5);
  });

  it("clampa em 0 quando há excesso (livre+trânsito > demanda)", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 2, emTransito: 5 });
    expect(r.necessidadeLiquida).toBe(0);
  });

  it("over-receive (emTransito negativo) é tratado como 0, não aumenta a necessidade", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 0, emTransito: -2 });
    expect(r.necessidadeLiquida).toBe(5);
  });

  it("devolve a quebra usada (transparência pro comprador)", () => {
    const r = calcularNecessidadeLiquida({ demandaAberta: 5, estoqueLivre: 1, emTransito: 0 });
    expect(r).toEqual({ demandaAberta: 5, estoqueLivre: 1, emTransito: 0, necessidadeLiquida: 4 });
  });
});
