import { describe, it, expect } from "vitest";
import {
  diaEmSaoPaulo,
  primeiroDiaInteiroPosCorte,
  criadoAntesDoDiaDoCorte,
} from "./sync-pedidos-corte";

// SP é UTC-3 (sem DST desde 2019): 14:00 SP = 17:00Z, meia-noite SP = 03:00Z.

describe("diaEmSaoPaulo", () => {
  it("converte UTC pro dia local de SP", () => {
    // 02:00Z = 23:00 do dia anterior em SP
    expect(diaEmSaoPaulo("2026-06-15T02:00:00Z")).toBe("2026-06-14");
    expect(diaEmSaoPaulo("2026-06-15T17:00:00Z")).toBe("2026-06-15");
  });
});

describe("primeiroDiaInteiroPosCorte", () => {
  it("corte com horário ⇒ dia seguinte", () => {
    // 14:00 SP do dia 15
    expect(primeiroDiaInteiroPosCorte("2026-06-15T17:00:00Z")).toBe("2026-06-16");
  });

  it("corte à meia-noite SP ⇒ o próprio dia", () => {
    expect(primeiroDiaInteiroPosCorte("2026-06-15T03:00:00Z")).toBe("2026-06-15");
  });

  it("vira mês corretamente", () => {
    // 20:00 SP do dia 30/06
    expect(primeiroDiaInteiroPosCorte("2026-06-30T23:00:00Z")).toBe("2026-07-01");
  });
});

describe("criadoAntesDoDiaDoCorte", () => {
  const corte = "2026-06-15T17:00:00Z"; // 14:00 SP do dia 15

  it("dia anterior ao corte ⇒ true", () => {
    expect(criadoAntesDoDiaDoCorte("2026-06-14", corte)).toBe(true);
  });

  it("o próprio dia do corte passa (granularidade de dia do Tiny)", () => {
    expect(criadoAntesDoDiaDoCorte("2026-06-15", corte)).toBe(false);
  });

  it("dia posterior passa", () => {
    expect(criadoAntesDoDiaDoCorte("2026-06-16", corte)).toBe(false);
  });

  it("aceita data com hora anexada (usa só o dia)", () => {
    expect(criadoAntesDoDiaDoCorte("2026-06-14 10:30:00", corte)).toBe(true);
  });

  it("sem corte ou sem data ⇒ false (não bloqueia)", () => {
    expect(criadoAntesDoDiaDoCorte("2026-06-14", null)).toBe(false);
    expect(criadoAntesDoDiaDoCorte(undefined, corte)).toBe(false);
    expect(criadoAntesDoDiaDoCorte("garbage", corte)).toBe(false);
  });
});
