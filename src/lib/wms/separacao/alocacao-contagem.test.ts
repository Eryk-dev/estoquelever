import { describe, it, expect } from "vitest";
import { alocarContagem } from "./alocacao-contagem";

describe("alocarContagem — distribui contagem maximizando pedidos liberados inteiros", () => {
  it("contagem cobre tudo → todos cobre_total", () => {
    const plano = alocarContagem(
      [
        { id: "a", qty: 1 },
        { id: "b", qty: 1 },
        { id: "c", qty: 1 },
      ],
      3,
    );
    expect(plano.get("a")).toEqual({ tipo: "cobre_total" });
    expect(plano.get("b")).toEqual({ tipo: "cobre_total" });
    expect(plano.get("c")).toEqual({ tipo: "cobre_total" });
  });

  it("item único maior que a contagem → parcial com a sobra (caso da tela: pede 3, contou 1)", () => {
    const plano = alocarContagem([{ id: "a", qty: 3 }], 1);
    expect(plano.get("a")).toEqual({ tipo: "parcial", qty_pega: 1 });
  });

  it("cobre o que dá, sobra vira parcial do próximo, resto esgotado", () => {
    const plano = alocarContagem(
      [
        { id: "a", qty: 2 },
        { id: "b", qty: 2 },
        { id: "c", qty: 2 },
      ],
      3,
    );
    expect(plano.get("a")).toEqual({ tipo: "cobre_total" });
    expect(plano.get("b")).toEqual({ tipo: "parcial", qty_pega: 1 });
    expect(plano.get("c")).toEqual({ tipo: "esgotado" });
  });

  it("maximiza número de pedidos: cobre os menores primeiro", () => {
    const plano = alocarContagem(
      [
        { id: "grande", qty: 5 },
        { id: "p1", qty: 1 },
        { id: "p2", qty: 1 },
      ],
      2,
    );
    expect(plano.get("p1")).toEqual({ tipo: "cobre_total" });
    expect(plano.get("p2")).toEqual({ tipo: "cobre_total" });
    expect(plano.get("grande")).toEqual({ tipo: "esgotado" });
  });

  it("sobra além do necessário fica na prateleira (sem plano extra)", () => {
    const plano = alocarContagem([{ id: "a", qty: 2 }], 5);
    expect(plano.get("a")).toEqual({ tipo: "cobre_total" });
    expect(plano.size).toBe(1);
  });

  it("contagem zero → tudo esgotado", () => {
    const plano = alocarContagem(
      [
        { id: "a", qty: 1 },
        { id: "b", qty: 2 },
      ],
      0,
    );
    expect(plano.get("a")).toEqual({ tipo: "esgotado" });
    expect(plano.get("b")).toEqual({ tipo: "esgotado" });
  });

  it("empate de quantidade desempata por id (determinístico)", () => {
    const plano = alocarContagem(
      [
        { id: "z", qty: 1 },
        { id: "a", qty: 1 },
      ],
      1,
    );
    expect(plano.get("a")).toEqual({ tipo: "cobre_total" });
    expect(plano.get("z")).toEqual({ tipo: "esgotado" });
  });
});
