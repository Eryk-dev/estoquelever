import { describe, it, expect } from "vitest";
import { ehChaveNf, escaparLike } from "./conferencia";

describe("ehChaveNf", () => {
  it("aceita exatamente 44 dígitos", () => {
    expect(ehChaveNf("35260634857388000163550010000123451000123456")).toBe(true);
  });
  it("rejeita 43/45 dígitos, letras e vazio", () => {
    expect(ehChaveNf("3526063485738800016355001000012345100012345")).toBe(false);
    expect(ehChaveNf("352606348573880001635500100001234510001234567")).toBe(false);
    expect(ehChaveNf("35260634857388000163550010000123451000123abc")).toBe(false);
    expect(ehChaveNf("")).toBe(false);
  });
});

describe("escaparLike", () => {
  it("escapa % _ e backslash", () => {
    expect(escaparLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
  it("código normal passa intacto", () => {
    expect(escaparLike("BR251400123456X")).toBe("BR251400123456X");
  });
});
