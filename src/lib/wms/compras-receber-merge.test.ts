import { describe, it, expect } from "vitest";
import { mergeReceberDocs } from "./compras-receber-merge";

describe("mergeReceberDocs", () => {
  it("agrupa OC + manual por fornecedor, com origem e id do documento", () => {
    const grupos = mergeReceberDocs(
      [{ id: "oc1", fornecedor: "Delphi", galpao_nome: "CWB", qty_pendente: 5, criado_em: "2026-06-01T00:00:00Z" }],
      [{ id: "m1", fornecedor: "Delphi", galpao_nome: "CWB", qty_pendente: 3, criado_em: "2026-06-02T00:00:00Z", custo_total: 30 }],
    );
    expect(grupos).toHaveLength(1);
    const g = grupos[0];
    expect(g.fornecedor).toBe("Delphi");
    expect(g.documentos).toHaveLength(2);
    expect(g.documentos.map((d) => d.origem).sort()).toEqual(["manual", "oc"]);
    expect(g.documentos.find((d) => d.origem === "oc")!.id).toBe("oc1");
    expect(g.documentos.find((d) => d.origem === "manual")!.id).toBe("m1");
  });

  it("fornecedores distintos viram grupos distintos, ordenados por nome", () => {
    const grupos = mergeReceberDocs(
      [{ id: "oc1", fornecedor: "Zeta", galpao_nome: null, qty_pendente: 1, criado_em: "2026-06-01T00:00:00Z" }],
      [{ id: "m1", fornecedor: "Alpha", galpao_nome: null, qty_pendente: 1, criado_em: "2026-06-01T00:00:00Z", custo_total: 0 }],
    );
    expect(grupos.map((g) => g.fornecedor)).toEqual(["Alpha", "Zeta"]);
  });
});
