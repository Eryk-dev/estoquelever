import { describe, it, expect } from "vitest";
import {
  PRAZO_DIA_SEM,
  diaSpParaRangeUtc,
  diaSpDePrazo,
  agruparPedidosPorDiaSp,
  construirOrPrazoDias,
} from "./prazo-dias";

describe("diaSpParaRangeUtc", () => {
  it("cobre o dia SP inteiro em UTC (SP = -03:00)", () => {
    expect(diaSpParaRangeUtc("2026-06-25")).toEqual({
      de: "2026-06-25T03:00:00.000Z",
      ate: "2026-06-26T03:00:00.000Z",
    });
  });
});

describe("diaSpDePrazo", () => {
  it("null → sem", () => {
    expect(diaSpDePrazo(null)).toBe(PRAZO_DIA_SEM);
  });
  it("23h SP (= 02h UTC do dia seguinte) cai no dia SP, não no UTC", () => {
    // 2026-06-26T02:00:00Z = 2026-06-25 23:00 em SP → dia 2026-06-25.
    expect(diaSpDePrazo("2026-06-26T02:00:00.000Z")).toBe("2026-06-25");
  });
  it("meio-dia UTC → mesmo dia em SP", () => {
    expect(diaSpDePrazo("2026-06-25T12:00:00.000Z")).toBe("2026-06-25");
  });
});

describe("agruparPedidosPorDiaSp", () => {
  it("agrupa por dia, conta, ordena asc e joga 'sem' pro fim", () => {
    const pedidos = [
      { prazo_envio: "2026-06-26T12:00:00.000Z" },
      { prazo_envio: "2026-06-25T12:00:00.000Z" },
      { prazo_envio: "2026-06-25T18:00:00.000Z" },
      { prazo_envio: null },
    ];
    expect(agruparPedidosPorDiaSp(pedidos)).toEqual([
      { dia: "2026-06-25", count: 2 },
      { dia: "2026-06-26", count: 1 },
      { dia: PRAZO_DIA_SEM, count: 1 },
    ]);
  });
  it("lista vazia → []", () => {
    expect(agruparPedidosPorDiaSp([])).toEqual([]);
  });
});

describe("construirOrPrazoDias", () => {
  it("um dia → and(gte,lt)", () => {
    expect(construirOrPrazoDias(["2026-06-25"])).toBe(
      "and(prazo_envio.gte.2026-06-25T03:00:00.000Z,prazo_envio.lt.2026-06-26T03:00:00.000Z)",
    );
  });
  it("vários dias + sem → OR de ranges + is.null", () => {
    expect(construirOrPrazoDias(["2026-06-25", "2026-06-27", "sem"])).toBe(
      "and(prazo_envio.gte.2026-06-25T03:00:00.000Z,prazo_envio.lt.2026-06-26T03:00:00.000Z)," +
        "and(prazo_envio.gte.2026-06-27T03:00:00.000Z,prazo_envio.lt.2026-06-28T03:00:00.000Z)," +
        "prazo_envio.is.null",
    );
  });
  it("lista vazia → null (sem filtro)", () => {
    expect(construirOrPrazoDias([])).toBeNull();
  });
  it("dia malformado é ignorado", () => {
    expect(construirOrPrazoDias(["lixo", "2026-13-99", ""])).toBeNull();
  });
});
