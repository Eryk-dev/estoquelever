import { describe, it, expect } from "vitest";
import { calcularExpiraEm } from "./reservas";

describe("calcularExpiraEm", () => {
  it("default 48h adiciona 48h ao now", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const r = calcularExpiraEm({ now, horas: 48 });
    expect(r.toISOString()).toBe("2026-01-03T10:00:00.000Z");
  });

  it("ttl custom 12h", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(calcularExpiraEm({ now, horas: 12 }).toISOString()).toBe(
      "2026-01-01T12:00:00.000Z",
    );
  });

  it("default sem opts usa 48h", () => {
    const before = Date.now();
    const r = calcularExpiraEm();
    const diff = r.getTime() - before;
    expect(diff).toBeGreaterThan(48 * 3600 * 1000 - 1000);
    expect(diff).toBeLessThan(48 * 3600 * 1000 + 1000);
  });
});
