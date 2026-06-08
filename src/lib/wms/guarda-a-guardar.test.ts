import { describe, it, expect } from "vitest";
import { calcularAGuardar } from "./guarda";

describe("calcularAGuardar", () => {
  it("a_guardar = min(qty_pendente, livre)", () => {
    expect(calcularAGuardar({ qty_pendente: 40, saldo: 10, reservado_alheio: 0 })).toBe(10);
    expect(calcularAGuardar({ qty_pendente: 5, saldo: 50, reservado_alheio: 0 })).toBe(5);
  });
  it("desconta reservado de pedidos (livre = saldo - reservado_alheio)", () => {
    expect(calcularAGuardar({ qty_pendente: 10, saldo: 10, reservado_alheio: 3 })).toBe(7);
  });
  it("saldo zero → 0 (guarda já consumida pelo pick)", () => {
    expect(calcularAGuardar({ qty_pendente: 40, saldo: 0, reservado_alheio: 0 })).toBe(0);
  });
  it("nunca negativo", () => {
    expect(calcularAGuardar({ qty_pendente: 5, saldo: 2, reservado_alheio: 9 })).toBe(0);
  });
});
