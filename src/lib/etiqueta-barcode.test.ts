import { describe, it, expect } from "vitest";
import { extrairBarcodesDoZpl, montarBarcodesEtiqueta } from "./etiqueta-barcode";

// Fixtures representativas da estrutura real das etiquetas que o Tiny entrega:
// - ML: ZPL de comandos (^BC Code128 + ^BQ QR), pode concatenar etiqueta de
//   envio + DANFE no mesmo arquivo (multi ^XA...^XZ).
// - Shopee: gráfico raster ~DG/^XG — NÃO tem ^BC/^FD; o barcode dela só entra
//   via codigoRastreio da expedição Tiny (montarBarcodesEtiqueta extras).
// Validar contra etiqueta real no primeiro bipe de staging.

const ZPL_ML = [
  "^XA",
  "^FO40,30^BCN,140,N,N,N^FD>;>:44123456789^FS",
  "^FT60,400^A0N,28,28^FDPedido: 2000013659039448^FS",
  "^FO500,50^BQN,2,5^FDLA,https://qr.ml.com/abc123^FS",
  "^XZ",
  "^XA",
  "^FO30,50^BCN,80,N,N,N^FD35260634857388000163550010000123451000123456^FS",
  "^XZ",
].join("\n");

describe("extrairBarcodesDoZpl", () => {
  it("extrai Code128 normalizando escapes de subset (>; >: etc)", () => {
    const r = extrairBarcodesDoZpl(ZPL_ML);
    expect(r).toContain("44123456789");
  });

  it("extrai todos os barcodes do arquivo (envio + DANFE) sem pegar ^FD de texto", () => {
    const r = extrairBarcodesDoZpl(ZPL_ML);
    expect(r).toContain("35260634857388000163550010000123451000123456");
    expect(r).not.toContain("Pedido: 2000013659039448");
  });

  it("extrai QR ^BQ removendo prefixo de modo (LA,/QA,/H,)", () => {
    const r = extrairBarcodesDoZpl(ZPL_ML);
    expect(r).toContain("https://qr.ml.com/abc123");
  });

  it("Code39 ^B3 também é extraído", () => {
    const r = extrairBarcodesDoZpl("^XA^FO10,10^B3N,N,100,Y,N^FDABC-12345^FS^XZ");
    expect(r).toContain("ABC-12345");
  });

  it("^FD sem comando de barcode antes é ignorado", () => {
    const r = extrairBarcodesDoZpl("^XA^FO10,10^A0N,30,30^FDtexto livre^FS^XZ");
    expect(r).toEqual([]);
  });

  it("barcode seguido de campo de texto: só o primeiro ^FD após o comando conta", () => {
    const r = extrairBarcodesDoZpl(
      "^XA^FO10,10^BCN,100,N,N,N^FD9876543210^FS^FO10,200^FDoutro texto^FS^XZ",
    );
    expect(r).toEqual(["9876543210"]);
  });

  it("dedup de barcodes repetidos", () => {
    const zpl = "^XA^BCN^FD123456^FS^XZ^XA^BCN^FD123456^FS^XZ";
    expect(extrairBarcodesDoZpl(zpl)).toEqual(["123456"]);
  });

  it("descarta valores curtos demais (<4 chars) e vazios", () => {
    const r = extrairBarcodesDoZpl("^XA^BCN^FD>:1^FS^BCN^FD^FS^XZ");
    expect(r).toEqual([]);
  });

  it("ZPL raster Shopee (~DG, sem ^BC) retorna []", () => {
    const shopee = "~DGR:SHOPEE.GRF,30000,75,:Z64:eJzt0jEKw...^XA^FO0,0^XGR:SHOPEE.GRF,1,1^FS^XZ^XA^IDR:SHOPEE.GRF^FS^XZ";
    expect(extrairBarcodesDoZpl(shopee)).toEqual([]);
  });

  it("string vazia / sem ZPL retorna []", () => {
    expect(extrairBarcodesDoZpl("")).toEqual([]);
  });

  it("^FH antes do ^FD não quebra a captura", () => {
    const r = extrairBarcodesDoZpl("^XA^FO10,10^BCN,100,N,N,N^FH^FD4412345678^FS^XZ");
    expect(r).toContain("4412345678");
  });
});

describe("montarBarcodesEtiqueta", () => {
  it("une barcodes do ZPL com extras (codigoRastreio), dedup, sem null/vazio", () => {
    const r = montarBarcodesEtiqueta(ZPL_ML, ["BR251400123456X", null, undefined, "", "44123456789"]);
    expect(r).toContain("BR251400123456X");
    expect(r).toContain("44123456789");
    expect(r.filter((b) => b === "44123456789")).toHaveLength(1);
  });

  it("ZPL null (Shopee sem cache) → só extras", () => {
    expect(montarBarcodesEtiqueta(null, ["BR251400123456X"])).toEqual(["BR251400123456X"]);
  });

  it("tudo vazio → []", () => {
    expect(montarBarcodesEtiqueta(null, [])).toEqual([]);
  });
});
