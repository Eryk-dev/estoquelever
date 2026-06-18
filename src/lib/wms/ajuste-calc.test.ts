import { describe, it, expect } from "vitest";
import { calcularAjustes } from "./ajuste-calc";

const L = (localizacao_id: string, saldo: number, reservado = 0) => ({
  localizacao_id,
  saldo,
  reservado,
});

describe("calcularAjustes", () => {
  it("loc não alterada (sem draft) não vira ajuste", () => {
    const r = calcularAjustes([L("a", 10)], {}, []);
    expect(r.ajustes).toEqual([]);
    expect(r.erroReserva).toBe(false);
    expect(r.erroDuplicada).toBe(false);
  });

  it("draft vazio = não alterado (não dispara saída ao limpar campo)", () => {
    const r = calcularAjustes([L("a", 10)], { a: "" }, []);
    expect(r.ajustes).toEqual([]);
  });

  it("real igual ao saldo → delta 0, sem ajuste", () => {
    const r = calcularAjustes([L("a", 10)], { a: "10" }, []);
    expect(r.ajustes).toEqual([]);
  });

  it("real > saldo → entrada com qty = delta", () => {
    const r = calcularAjustes([L("a", 10)], { a: "13" }, []);
    expect(r.ajustes).toEqual([
      { localizacao_id: "a", direcao: "entrada", qty: 3 },
    ]);
  });

  it("real < saldo → saída com qty = |delta|", () => {
    const r = calcularAjustes([L("a", 10)], { a: "7" }, []);
    expect(r.ajustes).toEqual([
      { localizacao_id: "a", direcao: "saida", qty: 3 },
    ]);
  });

  it("real abaixo do reservado → erroReserva, sem ajuste pra essa loc", () => {
    const r = calcularAjustes([L("a", 10, 4)], { a: "2" }, []);
    expect(r.erroReserva).toBe(true);
    expect(r.ajustes).toEqual([]);
  });

  it("real == reservado é permitido", () => {
    const r = calcularAjustes([L("a", 10, 4)], { a: "4" }, []);
    expect(r.erroReserva).toBe(false);
    expect(r.ajustes).toEqual([
      { localizacao_id: "a", direcao: "saida", qty: 6 },
    ]);
  });

  it("zerar loc (real 0, sem reserva) → saída total", () => {
    const r = calcularAjustes([L("a", 5)], { a: "0" }, []);
    expect(r.ajustes).toEqual([
      { localizacao_id: "a", direcao: "saida", qty: 5 },
    ]);
  });

  it("loc nova → entrada; custo informado vira custo_unitario", () => {
    const r = calcularAjustes([], {}, [
      { localizacao_id: "nova", qty: "5", custo: "12.5" },
    ]);
    expect(r.ajustes).toEqual([
      {
        localizacao_id: "nova",
        direcao: "entrada",
        qty: 5,
        custo_unitario: 12.5,
      },
    ]);
  });

  it("loc nova sem custo → entrada sem custo_unitario", () => {
    const r = calcularAjustes([], {}, [{ localizacao_id: "nova", qty: "5" }]);
    expect(r.ajustes).toEqual([
      { localizacao_id: "nova", direcao: "entrada", qty: 5 },
    ]);
  });

  it("loc nova com qty<=0 ou sem loc é ignorada", () => {
    const r = calcularAjustes([], {}, [
      { localizacao_id: "", qty: "5" },
      { localizacao_id: "x", qty: "0" },
      { localizacao_id: "y", qty: "-3" },
    ]);
    expect(r.ajustes).toEqual([]);
  });

  it("loc nova repetindo loc da lista → erroDuplicada", () => {
    const r = calcularAjustes([L("a", 10)], {}, [
      { localizacao_id: "a", qty: "3" },
    ]);
    expect(r.erroDuplicada).toBe(true);
    expect(r.ajustes).toEqual([]);
  });

  it("duas locs novas iguais → erroDuplicada (segunda ignorada)", () => {
    const r = calcularAjustes([], {}, [
      { localizacao_id: "z", qty: "3" },
      { localizacao_id: "z", qty: "4" },
    ]);
    expect(r.erroDuplicada).toBe(true);
    expect(r.ajustes).toEqual([
      { localizacao_id: "z", direcao: "entrada", qty: 3 },
    ]);
  });

  it("multi-loc: mistura entrada + saída numa confirmação", () => {
    const r = calcularAjustes(
      [L("a", 10), L("b", 5)],
      { a: "12", b: "2" },
      [{ localizacao_id: "c", qty: "4" }],
    );
    expect(r.ajustes).toEqual([
      { localizacao_id: "a", direcao: "entrada", qty: 2 },
      { localizacao_id: "b", direcao: "saida", qty: 3 },
      { localizacao_id: "c", direcao: "entrada", qty: 4 },
    ]);
  });
});
