import { describe, expect, it } from "vitest";
import { gerarZplEnderecoGrande, gerarZplEnderecoPequena } from "./zpl-endereco";

describe("etiquetas de endereço", () => {
  it("pareia duas posições na etiqueta pequena e mantém QR individual", () => {
    const zpl = gerarZplEnderecoPequena(["C-01-01-02", "C-01-01-03"]);
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    expect(zpl).toContain("^FDQA,C-01-01-02");
    expect(zpl).toContain("^FDQA,C-01-01-03");
  });

  it("gera uma etiqueta 10x15 por posição com texto e QR", () => {
    const zpl = gerarZplEnderecoGrande(["A-00-99", "B-01-02"]);
    expect(zpl.match(/\^XA/g)).toHaveLength(2);
    expect(zpl).toContain("^PW800");
    expect(zpl).toContain("^LL1200");
    expect(zpl).toContain("^FDQA,A-00-99");
  });
});
