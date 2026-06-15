import { describe, it, expect } from "vitest";
import { isMercadoLivre } from "./domain-helpers";

describe("isMercadoLivre", () => {
  it("aceita o nome canônico", () => {
    expect(isMercadoLivre("Mercado Livre")).toBe(true);
  });

  it("aceita variantes de canal por loja (prefixo ML_)", () => {
    expect(isMercadoLivre("ML_NET AIR")).toBe(true);
    expect(isMercadoLivre("ML_NETPARTS SP")).toBe(true);
  });

  it("aceita variante com 'mercado livre' no meio", () => {
    expect(isMercadoLivre("EASY MERCADO LIVRE")).toBe(true);
  });

  it("rejeita Shopee e outros", () => {
    expect(isMercadoLivre("Shopee")).toBe(false);
    expect(isMercadoLivre("Amazon")).toBe(false);
    expect(isMercadoLivre("MLB Store")).toBe(false); // "ML" sem separador não é canal ML
  });

  it("rejeita vazio/null", () => {
    expect(isMercadoLivre(null)).toBe(false);
    expect(isMercadoLivre(undefined)).toBe(false);
    expect(isMercadoLivre("")).toBe(false);
  });
});
