import { describe, it, expect } from "vitest";
import { regraTroca } from "./trocas-equivalencia-regra";

describe("regraTroca", () => {
  it("par bloqueado → bloqueada, mesmo com tiers iguais", () => {
    expect(
      regraTroca({
        tierVendido: "primeira_linha",
        tierSubstituto: "primeira_linha",
        parVerificacao: "bloqueado",
        misto: false,
      }),
    ).toEqual({ resultado: "bloqueada", tipo: null });
  });

  it("misto → aprovação 'misto', mesmo com par verificado e tier igual (D7)", () => {
    expect(
      regraTroca({
        tierVendido: "segunda_linha",
        tierSubstituto: "segunda_linha",
        parVerificacao: "verificado",
        misto: true,
      }),
    ).toEqual({ resultado: "aprovacao", tipo: "misto" });
  });

  it("tier ausente em qualquer lado → aprovação 'sem_classificacao'", () => {
    expect(
      regraTroca({
        tierVendido: null,
        tierSubstituto: "original",
        parVerificacao: "verificado",
        misto: false,
      }),
    ).toEqual({ resultado: "aprovacao", tipo: "sem_classificacao" });
    expect(
      regraTroca({
        tierVendido: "original",
        tierSubstituto: null,
        parVerificacao: "verificado",
        misto: false,
      }),
    ).toEqual({ resultado: "aprovacao", tipo: "sem_classificacao" });
  });

  it("mesmo tier + par verificado → LIVRE (auto-troca, D9)", () => {
    expect(
      regraTroca({
        tierVendido: "primeira_linha",
        tierSubstituto: "primeira_linha",
        parVerificacao: "verificado",
        misto: false,
      }),
    ).toEqual({ resultado: "livre", tipo: "mesmo_nivel" });
  });

  it("mesmo tier SEM par verificado → aprovação (regex OEM ruidoso não auto-troca)", () => {
    expect(
      regraTroca({
        tierVendido: "primeira_linha",
        tierSubstituto: "primeira_linha",
        parVerificacao: null,
        misto: false,
      }),
    ).toEqual({ resultado: "aprovacao", tipo: "mesmo_nivel" });
  });

  it("substituto melhor → aprovação 'upgrade' (D2: upgrade também passa por humano)", () => {
    expect(
      regraTroca({
        tierVendido: "segunda_linha",
        tierSubstituto: "original",
        parVerificacao: "verificado",
        misto: false,
      }),
    ).toEqual({ resultado: "aprovacao", tipo: "upgrade" });
  });

  it("substituto pior → aprovação 'downgrade'", () => {
    expect(
      regraTroca({
        tierVendido: "original",
        tierSubstituto: "primeira_linha",
        parVerificacao: "verificado",
        misto: false,
      }),
    ).toEqual({ resultado: "aprovacao", tipo: "downgrade" });
    expect(
      regraTroca({
        tierVendido: "primeira_linha",
        tierSubstituto: "segunda_linha",
        parVerificacao: null,
        misto: false,
      }),
    ).toEqual({ resultado: "aprovacao", tipo: "downgrade" });
  });
});
