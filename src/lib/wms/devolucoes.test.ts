import { describe, it, expect } from "vitest";
import { resolverEmpresaReferencia } from "./devolucoes";

describe("resolverEmpresaReferencia", () => {
  it("venda própria: referência = empresa vendedora", () => {
    expect(
      resolverEmpresaReferencia({
        origem_tipo: "nf_venda",
        empresa_vendedora_id: "v1",
      }),
    ).toBe("v1");
  });

  it("venda manual: referência = empresa vendedora", () => {
    expect(
      resolverEmpresaReferencia({
        origem_tipo: "venda_manual",
        empresa_vendedora_id: "v2",
      }),
    ).toBe("v2");
  });

  it("sem tag de vendedora: retorna null", () => {
    expect(
      resolverEmpresaReferencia({
        origem_tipo: "nf_venda",
        empresa_vendedora_id: null,
      }),
    ).toBeNull();
  });
});
