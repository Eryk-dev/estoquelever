import { describe, it, expect } from "vitest";
import { selecionarLiberaveisFifo } from "./reconciliador-oc";

describe("selecionarLiberaveisFifo — FIFO estrito, respeita saldo livre", () => {
  it("cobre o mais antigo e sobra não cobre o próximo (exemplo ACD003: 15 livre)", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "i2001", outstanding: 13 },
        { id: "i2050", outstanding: 10 },
      ],
      15,
    );
    expect(r[0]).toMatchObject({ id: "i2001", libera: true });
    expect(r[1]).toMatchObject({ id: "i2050", libera: false });
  });

  it("FIFO estrito: se o mais antigo não cabe, NÃO libera o mais novo (não fura fila)", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "velho", outstanding: 100 },
        { id: "novo", outstanding: 5 },
      ],
      10,
    );
    expect(r[0]).toMatchObject({ id: "velho", libera: false });
    expect(r[1]).toMatchObject({ id: "novo", libera: false });
  });

  it("libera vários em sequência enquanto o saldo livre aguenta", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "a", outstanding: 4 },
        { id: "b", outstanding: 4 },
        { id: "c", outstanding: 4 },
      ],
      9,
    );
    expect(r.map((x) => x.libera)).toEqual([true, true, false]);
  });

  it("outstanding 0 é ignorado e não bloqueia a fila", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "zero", outstanding: 0 },
        { id: "real", outstanding: 3 },
      ],
      3,
    );
    expect(r[0]).toMatchObject({ id: "zero", libera: false });
    expect(r[1]).toMatchObject({ id: "real", libera: true });
  });

  it("saldo livre 0 não libera nada", () => {
    const r = selecionarLiberaveisFifo([{ id: "a", outstanding: 1 }], 0);
    expect(r[0].libera).toBe(false);
  });

  it("item zero NO MEIO não bloqueia: libera antes e depois enquanto cabe", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "a", outstanding: 3 },
        { id: "zero", outstanding: 0 },
        { id: "b", outstanding: 3 },
      ],
      6,
    );
    expect(r.map((x) => x.libera)).toEqual([true, false, true]);
  });
});
