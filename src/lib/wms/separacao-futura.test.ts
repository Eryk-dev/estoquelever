import { describe, it, expect } from "vitest";
import { ttlHorasReservaFutura } from "./separacao-futura";

describe("ttlHorasReservaFutura", () => {
  const now = new Date("2026-06-24T12:00:00-03:00");

  it("prazo 2026-07-14 → ~34d (prazo + 14d buffer) a partir de 2026-06-24", () => {
    // botão 2000017087998330: dataPrevista 2026-07-14. 20d até o prazo + 14d = 34d.
    const ttl = ttlHorasReservaFutura("2026-07-14T23:59:59-03:00", now);
    const dias = ttl / 24;
    expect(dias).toBeGreaterThan(33);
    expect(dias).toBeLessThan(35);
  });

  it("cobre além dos 30d fixos do fluxo normal (não expiraria antes da etiqueta)", () => {
    const ttl = ttlHorasReservaFutura("2026-07-14T23:59:59-03:00", now);
    expect(ttl).toBeGreaterThan(30 * 24);
  });

  it("sem prazo → fallback 90d", () => {
    expect(ttlHorasReservaFutura(null, now)).toBe(90 * 24);
    expect(ttlHorasReservaFutura(undefined, now)).toBe(90 * 24);
  });

  it("prazo inválido → fallback 90d", () => {
    expect(ttlHorasReservaFutura("não-é-data", now)).toBe(90 * 24);
  });

  it("prazo já passou → fallback 90d (nunca TTL <= 0)", () => {
    expect(ttlHorasReservaFutura("2026-06-01T00:00:00-03:00", now)).toBe(90 * 24);
  });
});
