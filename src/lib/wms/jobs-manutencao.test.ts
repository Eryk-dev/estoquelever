import { describe, it, expect } from "vitest";
import { backoffManutencao } from "./jobs-manutencao";

describe("backoffManutencao — 30s / 5min / 10min (NÃO 1h)", () => {
  it("tentativa 1 → 30s", () => expect(backoffManutencao(1)).toBe(30_000));
  it("tentativa 2 → 5min", () => expect(backoffManutencao(2)).toBe(300_000));
  it("tentativa 3 → 10min", () => expect(backoffManutencao(3)).toBe(600_000));
  it("além de 3 → mantém 10min (não escala pra 1h)", () => expect(backoffManutencao(4)).toBe(600_000));
});
