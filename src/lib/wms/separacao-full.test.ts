import { describe, it, expect } from "vitest";
import { isPedidoFull, MARCADOR_FULL } from "./separacao-full";

describe("MARCADOR_FULL", () => {
  it("é o literal FULL", () => {
    expect(MARCADOR_FULL).toBe("FULL");
  });
});

describe("isPedidoFull", () => {
  it("separacao_full=true → true", () => {
    expect(isPedidoFull({ separacao_full: true })).toBe(true);
  });

  it("separacao_full=false → false", () => {
    expect(isPedidoFull({ separacao_full: false })).toBe(false);
  });

  it("separacao_full ausente (undefined) → false", () => {
    expect(isPedidoFull({})).toBe(false);
  });

  it("separacao_full=null → false", () => {
    expect(isPedidoFull({ separacao_full: null })).toBe(false);
  });
});
