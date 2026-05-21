import { describe, it, expect } from "vitest";
import { dedupNonNullIds, hidratarExecutores } from "./dashboard-tarefas";

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

describe("hidratarExecutores", () => {
  const usuarios = new Map([
    ["u1", { id: "u1", nome: "Ana", foto_url: "https://x/a.jpg" }],
    ["u2", { id: "u2", nome: "Bruno", foto_url: null }],
    ["u3", { id: "u3", nome: "Carla", foto_url: null }],
  ]);

  it("retorna [] quando ids está vazio", () => {
    expect(hidratarExecutores([], usuarios)).toEqual([]);
  });

  it("preserva ordem dos ids fornecidos", () => {
    const out = hidratarExecutores(["u2", "u1"], usuarios);
    expect(out.map((e) => e.id)).toEqual(["u2", "u1"]);
  });

  it("ignora ids ausentes no map (usuário deletado ou desconhecido)", () => {
    const out = hidratarExecutores(["u1", "ghost", "u2"], usuarios);
    expect(out.map((e) => e.id)).toEqual(["u1", "u2"]);
  });

  it("propaga foto_url null sem mexer", () => {
    const out = hidratarExecutores(["u2"], usuarios);
    expect(out).toEqual([{ id: "u2", nome: "Bruno", foto_url: null }]);
  });
});
