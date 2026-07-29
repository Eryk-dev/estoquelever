import { describe, expect, it } from "vitest";
import {
  normalizarSkuAnuncio,
  skuTemAnuncioAtivo,
} from "./ml-anuncios";

describe("normalização do relatório de anúncios", () => {
  it("compara SKU sem diferença de caixa ou espaços laterais", () => {
    const ativos = new Set(["ABC-123", "SKU 9"]);

    expect(normalizarSkuAnuncio(" abc-123 ")).toBe("ABC-123");
    expect(skuTemAnuncioAtivo("abc-123", ativos)).toBe(true);
    expect(skuTemAnuncioAtivo(" SKU 9 ", ativos)).toBe(true);
    expect(skuTemAnuncioAtivo("SEM-ANUNCIO", ativos)).toBe(false);
  });
});
