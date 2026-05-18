import { describe, it, expect } from "vitest";
import { naturalLocCompare } from "./loc-compare";

describe("naturalLocCompare", () => {
  it("ordena A-2 antes de A-10", () => {
    expect(naturalLocCompare("A-2", "A-10")).toBeLessThan(0);
  });
  it("ordena A antes de B", () => {
    expect(naturalLocCompare("A-01-01", "B-01-01")).toBeLessThan(0);
  });
  it("mantém ordem em códigos iguais", () => {
    expect(naturalLocCompare("A-01-02", "A-01-02")).toBe(0);
  });
});
