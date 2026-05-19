import { describe, it, expect } from "vitest";
import {
  validarTransferenciaIntraGalpao,
  validarItensRecebimento,
} from "./movimentacoes";

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

describe("validarItensRecebimento", () => {
  const LOC_RECEB = "loc-recebimento-id";

  it("rejeita lista vazia", () => {
    expect(() => validarItensRecebimento([], LOC_RECEB)).toThrow(
      /sem itens/i,
    );
  });

  it("rejeita item com loc destino == loc de RECEBIMENTO (bug 2026-05-19)", () => {
    expect(() =>
      validarItensRecebimento(
        [
          { produto_id: "p1", qty: 10, localizacao_destino_id: LOC_RECEB },
        ],
        LOC_RECEB,
      ),
    ).toThrow(/RECEBIMENTO/i);
  });

  it("aceita item sem loc destino (operador decide no tablet)", () => {
    expect(() =>
      validarItensRecebimento(
        [{ produto_id: "p1", qty: 10 }],
        LOC_RECEB,
      ),
    ).not.toThrow();
  });

  it("aceita item com loc destino diferente da RECEBIMENTO", () => {
    expect(() =>
      validarItensRecebimento(
        [
          {
            produto_id: "p1",
            qty: 10,
            localizacao_destino_id: "loc-A12",
          },
        ],
        LOC_RECEB,
      ),
    ).not.toThrow();
  });

  it("aceita múltiplos itens no mesmo destino (≠ recebimento)", () => {
    expect(() =>
      validarItensRecebimento(
        [
          { produto_id: "p1", qty: 10, localizacao_destino_id: "loc-A12" },
          { produto_id: "p2", qty: 5, localizacao_destino_id: "loc-A12" },
        ],
        LOC_RECEB,
      ),
    ).not.toThrow();
  });

  it("identifica qual item está bugado quando há múltiplos", () => {
    expect(() =>
      validarItensRecebimento(
        [
          { produto_id: "p1", qty: 10, localizacao_destino_id: "loc-A12" },
          { produto_id: "p2", qty: 5, localizacao_destino_id: LOC_RECEB },
          { produto_id: "p3", qty: 2, localizacao_destino_id: "loc-B03" },
        ],
        LOC_RECEB,
      ),
    ).toThrow(/item 2/i);
  });
});
