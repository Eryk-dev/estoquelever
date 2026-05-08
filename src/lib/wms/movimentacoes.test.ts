import { describe, it, expect } from "vitest";
import { validarTransferenciaIntraGalpao } from "./movimentacoes";

describe("validarTransferenciaIntraGalpao", () => {
  it("rejeita quando origem == destino", () => {
    expect(() =>
      validarTransferenciaIntraGalpao({
        localizacao_origem_id: "X",
        localizacao_destino_id: "X",
      }),
    ).toThrow(/origem.*destino/i);
  });

  it("aceita origem != destino", () => {
    expect(() =>
      validarTransferenciaIntraGalpao({
        localizacao_origem_id: "A",
        localizacao_destino_id: "B",
      }),
    ).not.toThrow();
  });
});
