import { describe, it, expect } from "vitest";
import {
  normalizarPar,
  saoLigaveis,
  outroLado,
  statusParaRegra,
  montarEquivalentes,
  normalizarOem,
  oemEmComum,
  montarOndeComprar,
  type CrossPar,
  type ProdutoMin,
  type FornecedorPoolEntrada,
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

describe("normalizarOem", () => {
  it("tira separadores e caixa pra comparar códigos", () => {
    expect(normalizarOem("4B0 260 403 R")).toBe("4B0260403R");
    expect(normalizarOem("4b0.260-403/r")).toBe("4B0260403R");
    expect(normalizarOem("  ri.700.821 ")).toBe("RI700821");
    expect(normalizarOem("")).toBe("");
  });
});

describe("oemEmComum", () => {
  it("interseção normalizada (ignora separadores/caixa), dedup", () => {
    expect(oemEmComum(["4B0 260 403 R", "X1"], ["4b0260403r"])).toEqual(["4B0260403R"]);
    expect(oemEmComum(["A1"], ["B2"])).toEqual([]);
    expect(oemEmComum(null, ["A1"])).toEqual([]);
    expect(oemEmComum(["A1", "a 1"], ["A1"])).toEqual(["A1"]);
  });
});

describe("montarOndeComprar", () => {
  const f = (
    nome: string,
    codigo: string | null,
    preferencial = false,
  ): FornecedorPoolEntrada => ({
    fornecedorId: nome,
    nome,
    codigo_fornecedor: codigo,
    custo_unitario: null,
    galpao_id: null,
    galpao_nome: null,
    preferencial,
  });

  it("pool com próprio primeiro, equivalentes depois, com proveniência", () => {
    const linhas = montarOndeComprar({
      selfSku: "003505",
      grupoSkus: ["003505", "A143605"],
      fornecedoresPorSku: {
        "003505": [f("ACA", "003505", true)],
        A143605: [f("Royce", "RI.700.821", true)],
      },
    });
    expect(linhas.map((l) => [l.sku, l.nome, l.origem])).toEqual([
      ["003505", "ACA", "proprio"],
      ["A143605", "Royce", "equivalente"],
    ]);
    expect(linhas[1].codigo_fornecedor).toBe("RI.700.821");
  });

  it("SKU sem fornecedor cadastrado não quebra; lista vazia → []", () => {
    expect(
      montarOndeComprar({ selfSku: "X", grupoSkus: ["X"], fornecedoresPorSku: {} }),
    ).toEqual([]);
  });
});
