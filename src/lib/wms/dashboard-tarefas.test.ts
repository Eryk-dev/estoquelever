import { describe, it, expect } from "vitest";
import { dedupNonNullIds } from "./dashboard-tarefas";

describe("dedupNonNullIds", () => {
  it("retorna [] quando entrada é vazia", () => {
    expect(dedupNonNullIds([])).toEqual([]);
  });

  it("remove nulls e undefined", () => {
    expect(dedupNonNullIds([null, "a", undefined, "b"])).toEqual(["a", "b"]);
  });

  it("dedupa mantendo ordem de primeira aparição", () => {
    expect(dedupNonNullIds(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("trata todos null/undefined como vazio", () => {
    expect(dedupNonNullIds([null, null, undefined])).toEqual([]);
  });
});
