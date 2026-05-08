import { describe, it, expect } from "vitest";
import { calcularPosteriores, validarCoerencia } from "./ledger";

describe("calcularPosteriores", () => {
  it("entrada (E): incrementa saldo, reservado inalterado", () => {
    const r = calcularPosteriores({ tipo: "E", qty: 10, saldoAnterior: 5, reservadoAnterior: 2 });
    expect(r).toEqual({ saldo_posterior: 15, reservado_posterior: 2 });
  });

  it("saída (S): decrementa saldo, reservado inalterado", () => {
    const r = calcularPosteriores({ tipo: "S", qty: 3, saldoAnterior: 10, reservadoAnterior: 4 });
    expect(r).toEqual({ saldo_posterior: 7, reservado_posterior: 4 });
  });

  it("reserva (R): saldo inalterado, reservado +qty", () => {
    const r = calcularPosteriores({ tipo: "R", qty: 2, saldoAnterior: 10, reservadoAnterior: 1 });
    expect(r).toEqual({ saldo_posterior: 10, reservado_posterior: 3 });
  });

  it("liberação (L): saldo inalterado, reservado -qty", () => {
    const r = calcularPosteriores({ tipo: "L", qty: 2, saldoAnterior: 10, reservadoAnterior: 5 });
    expect(r).toEqual({ saldo_posterior: 10, reservado_posterior: 3 });
  });
});

describe("validarCoerencia", () => {
  it("rejeita saída com saldo insuficiente", () => {
    expect(() =>
      validarCoerencia({ tipo: "S", qty: 10, saldoAnterior: 5, reservadoAnterior: 0 }),
    ).toThrow(/saldo insuficiente/i);
  });

  it("rejeita reserva quando reservado_posterior > saldo_posterior", () => {
    expect(() =>
      validarCoerencia({ tipo: "R", qty: 5, saldoAnterior: 10, reservadoAnterior: 8 }),
    ).toThrow(/reservado.*saldo/i);
  });

  it("rejeita liberação maior que reservado", () => {
    expect(() =>
      validarCoerencia({ tipo: "L", qty: 10, saldoAnterior: 10, reservadoAnterior: 5 }),
    ).toThrow(/libera|reservado/i);
  });

  it("aceita movimento válido", () => {
    expect(() =>
      validarCoerencia({ tipo: "E", qty: 1, saldoAnterior: 0, reservadoAnterior: 0 }),
    ).not.toThrow();
  });
});
