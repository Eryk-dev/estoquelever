import { describe, it, expect } from "vitest";
import { isDevolucao } from "./devolucao-detector";

describe("isDevolucao", () => {
  it("detecta finalidade=4 (string)", () => {
    expect(isDevolucao({ finalidade: "4" })).toBe(true);
  });

  it("detecta finalidade=4 (number)", () => {
    expect(isDevolucao({ finalidade: 4 })).toBe(true);
  });

  it("detecta CFOP 1201, 1202, 5201, 5202", () => {
    expect(isDevolucao({ cfop: "1201" })).toBe(true);
    expect(isDevolucao({ cfop: "1202" })).toBe(true);
    expect(isDevolucao({ cfop: "5201" })).toBe(true);
    expect(isDevolucao({ cfop: "5202" })).toBe(true);
  });

  it("não confunde CFOP de venda normal com devolução", () => {
    expect(isDevolucao({ cfop: "5102" })).toBe(false);
    expect(isDevolucao({ cfop: "5101" })).toBe(false);
    expect(isDevolucao({ cfop: "1102" })).toBe(false);
    expect(isDevolucao({ cfop: "6201" })).toBe(false); // fora do range [15]
  });

  it("detecta natureza_operacao com 'devolução' (com acento)", () => {
    expect(isDevolucao({ natureza_operacao: "Devolução de venda" })).toBe(true);
    expect(isDevolucao({ natureza_operacao: "devolução de compra" })).toBe(true);
  });

  it("detecta natureza_operacao com 'devolucao' (sem acento, case insensitive)", () => {
    expect(isDevolucao({ natureza_operacao: "DEVOLUCAO" })).toBe(true);
    expect(isDevolucao({ natureza_operacao: "Devolucao de mercadoria" })).toBe(true);
  });

  it("não confunde natureza_operacao de venda comum", () => {
    expect(isDevolucao({ natureza_operacao: "Venda de mercadoria" })).toBe(false);
    expect(isDevolucao({ natureza_operacao: "Remessa para conserto" })).toBe(false);
  });

  it("detecta nf_referenciada com chaves preenchidas", () => {
    expect(isDevolucao({ nf_referenciada: { chave_acesso: "abc" } })).toBe(true);
  });

  it("ignora nf_referenciada vazia (objeto sem chaves)", () => {
    expect(isDevolucao({ nf_referenciada: {} })).toBe(false);
  });

  it("ignora nf_referenciada nulo/undefined", () => {
    expect(isDevolucao({ nf_referenciada: undefined })).toBe(false);
    expect(isDevolucao({ nf_referenciada: null as unknown as undefined })).toBe(false);
  });

  it("retorna false para payload vazio", () => {
    expect(isDevolucao({})).toBe(false);
  });

  it("retorna true se qualquer heurística cascar (compostos)", () => {
    // finalidade=4 + outros — basta a primeira
    expect(isDevolucao({ finalidade: 4, cfop: "5102", natureza_operacao: "Venda" })).toBe(true);
  });
});
