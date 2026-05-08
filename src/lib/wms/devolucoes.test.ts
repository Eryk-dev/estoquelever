import { describe, it, expect } from "vitest";
import { resolverDonaDestino } from "./devolucoes";

describe("resolverDonaDestino", () => {
  it("venda própria: dona = empresa vendedora", () => {
    const r = resolverDonaDestino({
      origem_tipo: "nf_venda",
      empresa_dona_id: "v1",
      emprestimo_devedora_id: null,
    });
    expect(r).toEqual({ dona_id: "v1", quita_emprestimo: false });
  });

  it("empréstimo: dona = credora original (auto-quita)", () => {
    const r = resolverDonaDestino({
      origem_tipo: "emprestimo",
      empresa_dona_id: "credora",
      emprestimo_devedora_id: "vendedora",
    });
    expect(r).toEqual({ dona_id: "credora", quita_emprestimo: true });
  });
});
