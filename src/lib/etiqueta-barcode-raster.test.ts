import { describe, it, expect } from "vitest";
import { extrairBarcodesDoRaster } from "./etiqueta-barcode-raster";

// Fixture sintético (sem PII): ~DG Z64 de um Code128 que codifica
// "TESTRASTER12345", gerado por zxing e empacotado como a Shopee entrega
// (etiqueta = 1 bitmap ~DG + ^XG, zero código como texto no ZPL).
const ZPL_RASTER =
  "~DGR:TEST.GRF,5300,53,:Z64:eJzty7EJwDAMAEGBWoNWMaQVeHVBWoFWCbgVJITMkO6/+uZEbIb3iK2VttRHp307Pa5j25l9L+8qVTPdLm8gEAgEAoFAIBAIBAKBQCAQCPQLegAh3kq9:74FC^XA^FO0,0^XGR:TEST.GRF,1,1^FS^XZ";

describe("extrairBarcodesDoRaster", () => {
  it("decodifica o barcode impresso no bitmap ~DG", async () => {
    const r = await extrairBarcodesDoRaster(ZPL_RASTER);
    expect(r).toContain("TESTRASTER12345");
  });

  it("ignora ZPL de comandos (ML, sem ~DG) — retorna []", async () => {
    const ml = "^XA^FO40,30^BCN,140,N,N,N^FD>;>:44123456789^FS^XZ";
    expect(await extrairBarcodesDoRaster(ml)).toEqual([]);
  });

  it("string vazia / null → []", async () => {
    expect(await extrairBarcodesDoRaster("")).toEqual([]);
    expect(await extrairBarcodesDoRaster(null)).toEqual([]);
    expect(await extrairBarcodesDoRaster(undefined)).toEqual([]);
  });

  it("~DG corrompido não lança — retorna []", async () => {
    expect(await extrairBarcodesDoRaster("~DGR:X.GRF,100,10,:Z64:lixo!!!:0000^XZ")).toEqual([]);
  });
});
