import { describe, expect, it } from "vitest";
import {
  gerarZplProduto,
  expandirPorQty,
  contarFolhas,
  type EtiquetaProdutoInput,
} from "./zpl-produto";

const A: EtiquetaProdutoInput = {
  sku: "19ABC123",
  descricao: "Filtro de óleo",
  localizacao: "A-01-1",
};

const B: EtiquetaProdutoInput = {
  sku: "EWXYZ",
  descricao: "Pastilha de freio",
  localizacao: "B-02-3",
};

describe("expandirPorQty", () => {
  it("expande qty=N pra N cópias da etiqueta", () => {
    const r = expandirPorQty([{ etiqueta: A, qty: 3 }]);
    expect(r.length).toBe(3);
    expect(r.every((x) => x.sku === "19ABC123")).toBe(true);
  });

  it("preserva ordem entre linhas diferentes", () => {
    const r = expandirPorQty([
      { etiqueta: A, qty: 2 },
      { etiqueta: B, qty: 1 },
    ]);
    expect(r.map((x) => x.sku)).toEqual(["19ABC123", "19ABC123", "EWXYZ"]);
  });

  it("clampa qty<=0 ou fracionário pra 1", () => {
    expect(expandirPorQty([{ etiqueta: A, qty: 0 }]).length).toBe(1);
    expect(expandirPorQty([{ etiqueta: A, qty: -5 }]).length).toBe(1);
    expect(expandirPorQty([{ etiqueta: A, qty: 1.7 }]).length).toBe(1);
    expect(expandirPorQty([{ etiqueta: A, qty: 2.9 }]).length).toBe(2);
  });
});

describe("contarFolhas", () => {
  it("conta folhas pareando 2 a 2", () => {
    expect(contarFolhas(0)).toBe(0);
    expect(contarFolhas(1)).toBe(1);
    expect(contarFolhas(2)).toBe(1);
    expect(contarFolhas(3)).toBe(2);
    expect(contarFolhas(5)).toBe(3);
  });
});

describe("gerarZplProduto", () => {
  it("retorna string vazia pra lista vazia", () => {
    expect(gerarZplProduto([])).toBe("");
  });

  it("gera 1 folha pra 1 etiqueta (direita em branco)", () => {
    const zpl = gerarZplProduto([A]);
    expect(zpl.match(/\^XA/g)?.length).toBe(1);
    expect(zpl.match(/\^XZ/g)?.length).toBe(1);
    expect(zpl).toContain("FD19ABC123");
    expect(zpl).toContain("FDA-01-1");
    expect(zpl).toContain("Filtro de óleo");
  });

  it("gera 1 folha pra 2 etiquetas (pareadas)", () => {
    const zpl = gerarZplProduto([A, B]);
    expect(zpl.match(/\^XA/g)?.length).toBe(1);
    expect(zpl.match(/\^XZ/g)?.length).toBe(1);
    expect(zpl).toContain("FD19ABC123");
    expect(zpl).toContain("FDEWXYZ");
  });

  it("gera 2 folhas pra 3 etiquetas (par + ímpar)", () => {
    const zpl = gerarZplProduto([A, B, A]);
    expect(zpl.match(/\^XA/g)?.length).toBe(2);
    expect(zpl.match(/\^XZ/g)?.length).toBe(2);
  });

  it("coluna direita usa offset 400 (segundo bloco com FOx onde x>=400)", () => {
    const zpl = gerarZplProduto([A, B]);
    // Posições do barcode da direita: FO{>=400},80
    expect(zpl).toMatch(/\^FO[4-9]\d{2},80\^BCN/);
    // Footer SKU da direita: 400 + LEFT_MARGIN=5
    expect(zpl).toContain("^FO405,150");
  });

  it("não emite QR code (apenas CODE128)", () => {
    const zpl = gerarZplProduto([A, B]);
    expect(zpl).not.toMatch(/\^BQ/);
    // 2 barcodes (um por etiqueta)
    expect(zpl.match(/\^BCN,/g)?.length).toBe(2);
  });

  it("barcode com MODULE_WIDTH=1 (^BY1) — versão original", () => {
    const zpl = gerarZplProduto([A]);
    expect(zpl).toContain("^BY1,2,50");
  });

  it("limpa newlines no input pra não quebrar ZPL", () => {
    const sujo: EtiquetaProdutoInput = {
      sku: "X\n123",
      descricao: "linha 1\r\nlinha 2",
      localizacao: "A\n01",
    };
    const zpl = gerarZplProduto([sujo]);
    // sem newlines literais no meio dos campos FD (newlines de formatação OK)
    expect(zpl).not.toMatch(/\^FD[^\^]*\n[^\^]*\^FS/);
    expect(zpl).toContain("FDX 123");
    expect(zpl).toContain("FDlinha 1 linha 2");
  });

  it("descrição curta usa font 25, 2 linhas", () => {
    const zpl = gerarZplProduto([A]);
    expect(zpl).toContain("^CF0,25");
    expect(zpl).toMatch(/\^FB\d+,2,,C\^FDFiltro de óleo/);
  });

  it("descrição média (~55 chars) cai pra font 22, 2 linhas", () => {
    const longa: EtiquetaProdutoInput = {
      sku: "ABC123",
      descricao: "FILTRO DE OLEO MOTOR FIAT PALIO STRADA UNO MILLE FIRE",
      localizacao: "A-01-1",
    };
    const zpl = gerarZplProduto([longa]);
    expect(zpl).toContain("^CF0,22");
    expect(zpl).toMatch(/\^FB\d+,2,,C\^FD/);
  });

  it("descrição longa (~100 chars) cai pra font 18, 3 linhas", () => {
    const muitoLonga: EtiquetaProdutoInput = {
      sku: "ABC123",
      descricao:
        "FILTRO DE OLEO MOTOR 1.0 1.4 1.6 PALIO STRADA UNO MILLE FIRE FLEX 2010 2011 2012 ORIGINAL",
      localizacao: "A-01-1",
    };
    const zpl = gerarZplProduto([muitoLonga]);
    expect(zpl).toContain("^CF0,18");
    expect(zpl).toMatch(/\^FB\d+,3,,C\^FD/);
  });

  it("descrição absurda (>140 chars) é truncada com elipse", () => {
    const absurda: EtiquetaProdutoInput = {
      sku: "ABC",
      descricao: "X".repeat(200),
      localizacao: "A-01-1",
    };
    const zpl = gerarZplProduto([absurda]);
    expect(zpl).toContain("^CF0,15");
    // Texto truncado em 139 chars + "…"
    expect(zpl).toContain("X".repeat(139) + "…");
    expect(zpl).not.toContain("X".repeat(140));
  });

  it("integra com expandirPorQty: qty=5 vira 3 folhas (5 etiq)", () => {
    const etqs = expandirPorQty([{ etiqueta: A, qty: 5 }]);
    expect(etqs.length).toBe(5);
    const zpl = gerarZplProduto(etqs);
    expect(zpl.match(/\^XA/g)?.length).toBe(contarFolhas(5));
    expect(zpl.match(/\^XA/g)?.length).toBe(3);
  });

  it("PW e LL ficam no início de cada folha", () => {
    const zpl = gerarZplProduto([A, B, A]);
    expect(zpl.match(/\^PW800/g)?.length).toBe(2);
    expect(zpl.match(/\^LL200/g)?.length).toBe(2);
  });
});
