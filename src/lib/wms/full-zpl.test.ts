import { describe, expect, it } from "vitest";
import { reordenarZplFullPorLocalizacao, separarEtiquetasZpl } from "./full-zpl";

const label = (id: string) => `^XA\n^FD${id}^FS\n^XZ`;

describe("reordenação do ZPL Full", () => {
  it("preserva cada etiqueta inteira e ordena pela localização natural", () => {
    const result = reordenarZplFullPorLocalizacao(
      [label("SKU-Z"), label("SKU-A"), label("SKU-B")].join("\n"),
      [
        { sku: "Z", quantidade: 1, ordem: 1, localizacao: "C-10-01" },
        { sku: "A", quantidade: 1, ordem: 2, localizacao: "C-02-01" },
        { sku: "B", quantidade: 1, ordem: 3, localizacao: "C-02-02" },
      ],
    );
    expect(separarEtiquetasZpl(result.zpl).map((z) => z.match(/\^FD(.*?)\^FS/)?.[1])).toEqual([
      "SKU-A", "SKU-B", "SKU-Z",
    ]);
  });

  it("bloqueia quando a quantidade de etiquetas não bate", () => {
    expect(() => reordenarZplFullPorLocalizacao(label("A"), [
      { sku: "A", quantidade: 2, ordem: 1, localizacao: "A-01-01" },
    ])).toThrow("1 etiquetas");
  });
});
