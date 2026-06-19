import { describe, it, expect } from "vitest";
import {
  normalizarPar,
  saoLigaveis,
  outroLado,
  statusParaRegra,
  montarEquivalentes,
  type CrossPar,
  type ProdutoMin,
} from "./equivalencias-core";

describe("normalizarPar", () => {
  it("ordena a<b independente da ordem de entrada", () => {
    expect(normalizarPar("B", "A")).toEqual({ sku_a: "A", sku_b: "B" });
    expect(normalizarPar("A", "B")).toEqual({ sku_a: "A", sku_b: "B" });
  });
});

describe("saoLigaveis", () => {
  it("recusa ligar peça com ela mesma", () => {
    expect(saoLigaveis("A", "A")).toBe(false);
    expect(saoLigaveis("A", "B")).toBe(true);
  });
});

describe("outroLado", () => {
  it("devolve o lado oposto do par", () => {
    const par = { sku_a: "A", sku_b: "B" };
    expect(outroLado(par, "A")).toBe("B");
    expect(outroLado(par, "B")).toBe("A");
  });
});

describe("statusParaRegra", () => {
  it("mapeia confirmado→verificado, bloqueado→bloqueado, sugestao→null", () => {
    expect(statusParaRegra("confirmado")).toBe("verificado");
    expect(statusParaRegra("bloqueado")).toBe("bloqueado");
    expect(statusParaRegra("sugestao")).toBe(null);
  });
});

describe("montarEquivalentes", () => {
  const produtos: Record<string, ProdutoMin> = {
    A: { sku: "A", descricao: "Peça A", imagem_url: "a.jpg", imagens: ["a.jpg"], tier_qualidade: "original" },
    B: { sku: "B", descricao: "Peça B", imagem_url: "b.jpg", imagens: ["b.jpg"], tier_qualidade: "primeira_linha" },
    C: { sku: "C", descricao: "Peça C", imagem_url: null, imagens: null, tier_qualidade: null },
  };
  const pares: CrossPar[] = [
    { id: 1, sku_a: "A", sku_b: "B", relacao: "equivalente", status: "confirmado", fonte: "manual" },
    { id: 2, sku_a: "A", sku_b: "C", relacao: "equivalente", status: "sugestao", fonte: "manual" },
  ];
  const estoque = {
    B: { CWB: { saldo: 5, reservado: 1, disponivel: 4, localizacaoTop: "P1" } },
    C: {},
  };

  it("monta equivalentes diretos de A com produto + estoque + status", () => {
    const r = montarEquivalentes({ sku: "A", pares, produtosPorSku: produtos, estoquePorSku: estoque, incluirBloqueado: true });
    expect(r.sku).toBe("A");
    expect(r.equivalentes.map((e) => e.sku).sort()).toEqual(["B", "C"]);
    const b = r.equivalentes.find((e) => e.sku === "B")!;
    expect(b.status).toBe("confirmado");
    expect(b.descricao).toBe("Peça B");
    expect(b.estoquePorGalpao).toEqual({ CWB: { saldo: 5, reservado: 1, disponivel: 4, localizacaoTop: "P1" } });
  });

  it("oculta pares bloqueado quando incluirBloqueado=false", () => {
    const comBloq: CrossPar[] = [
      ...pares,
      { id: 3, sku_a: "A", sku_b: "D", relacao: "equivalente", status: "bloqueado", fonte: "manual" },
    ];
    const prod2 = { ...produtos, D: { sku: "D", descricao: "Peça D", imagem_url: null, imagens: null, tier_qualidade: null } };
    const r = montarEquivalentes({ sku: "A", pares: comBloq, produtosPorSku: prod2, estoquePorSku: estoque, incluirBloqueado: false });
    expect(r.equivalentes.find((e) => e.sku === "D")).toBeUndefined();
  });

  it("ignora pares sem produto carregado", () => {
    const r = montarEquivalentes({ sku: "A", pares, produtosPorSku: { A: produtos.A }, estoquePorSku: {}, incluirBloqueado: true });
    expect(r.equivalentes).toEqual([]);
  });
});
