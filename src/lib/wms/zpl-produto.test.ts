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

  it("coluna direita usa offset 440 (shift de 5mm pra compensar gap físico)", () => {
    const zpl = gerarZplProduto([A, B]);
    // Posições do barcode da direita: FO{>=440},80
    expect(zpl).toMatch(/\^FO[4-9]\d{2},80\^BCN/);
    // Posições do footer SKU da direita: começa em 445 (440 + LEFT_MARGIN=5)
    expect(zpl).toContain("^FO445,150");
  });

  it("emite QR code (BQ) ao lado do barcode (BC) pra cada etiqueta", () => {
    const zpl = gerarZplProduto([A, B]);
    // 2 QRs (um por etiqueta) com data MA,<sku>
    expect(zpl.match(/\^BQN,2,\d\^FDMA,19ABC123\^FS/g)?.length).toBe(1);
    expect(zpl.match(/\^BQN,2,\d\^FDMA,EWXYZ\^FS/g)?.length).toBe(1);
    // 2 barcodes (um por etiqueta)
    expect(zpl.match(/\^BCN,/g)?.length).toBe(2);
  });

  it("QR e barcode são centralizados como grupo (QR.X < Barcode.X, mesma metade)", () => {
    const zpl = gerarZplProduto([A]);
    const qrMatch = zpl.match(/\^FO(\d+),\d+\^BQN/);
    const bcMatch = zpl.match(/\^FO(\d+),\d+\^BCN/);
    expect(qrMatch).toBeTruthy();
    expect(bcMatch).toBeTruthy();
    const qrX = Number(qrMatch![1]);
    const bcX = Number(bcMatch![1]);
    // QR vem antes do barcode com pouco gap
    expect(bcX).toBeGreaterThan(qrX);
    // Grupo cabe dentro da etiqueta esquerda (0..400)
    expect(qrX).toBeGreaterThanOrEqual(0);
    expect(bcX).toBeLessThan(400);
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

  it("integra com expandirPorQty: qty=5 vira 3 folhas (5 etiq)", () => {
    const etqs = expandirPorQty([{ etiqueta: A, qty: 5 }]);
    expect(etqs.length).toBe(5);
    const zpl = gerarZplProduto(etqs);
    expect(zpl.match(/\^XA/g)?.length).toBe(contarFolhas(5));
    expect(zpl.match(/\^XA/g)?.length).toBe(3);
  });

  it("PW e LL ficam no início de cada folha", () => {
    const zpl = gerarZplProduto([A, B, A]);
    expect(zpl.match(/\^PW840/g)?.length).toBe(2);
    expect(zpl.match(/\^LL200/g)?.length).toBe(2);
  });
});
