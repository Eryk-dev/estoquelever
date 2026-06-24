import { describe, it, expect } from "vitest";
import { preempcaoViabiliza } from "./preempcao-futura";

describe("preempcaoViabiliza — ready escasso preempta futura não-picada", () => {
  it("1 peça: futura reservou tudo (D=0,F=1), ready precisa 1 → preempta", () => {
    // disponivel=0 (a futura segura a única peça), soltando volta 1 → cobre.
    expect(
      preempcaoViabiliza([{ disponivel: 0, futuraReservado: 1, necessario: 1 }]),
    ).toBe(true);
  });

  it("futura JÁ picada (sem R viva → F=0) e sem estoque → NÃO preempta (ready vai pra OC)", () => {
    // peça já saiu (picada): não há futura reservada pra soltar; D=0,F=0 < 1.
    expect(
      preempcaoViabiliza([{ disponivel: 0, futuraReservado: 0, necessario: 1 }]),
    ).toBe(false);
  });

  it("ready já cobre sem mexer (D>=qty) → NÃO preempta", () => {
    expect(
      preempcaoViabiliza([{ disponivel: 5, futuraReservado: 2, necessario: 3 }]),
    ).toBe(false);
  });

  it("multi-item: um item não cobre nem soltando futura → NÃO preempta (propria exige todos)", () => {
    expect(
      preempcaoViabiliza([
        { disponivel: 0, futuraReservado: 1, necessario: 1 }, // ok ao soltar
        { disponivel: 0, futuraReservado: 0, necessario: 2 }, // impossível
      ]),
    ).toBe(false);
  });

  it("multi-item: todos cobrem ao soltar futura e ao menos um curto → preempta", () => {
    expect(
      preempcaoViabiliza([
        { disponivel: 0, futuraReservado: 1, necessario: 1 },
        { disponivel: 3, futuraReservado: 0, necessario: 3 }, // já cobre, não bloqueia
      ]),
    ).toBe(true);
  });

  it("lista vazia → false", () => {
    expect(preempcaoViabiliza([])).toBe(false);
  });
});
