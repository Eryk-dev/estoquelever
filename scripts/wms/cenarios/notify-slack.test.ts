import { describe, it, expect } from "vitest";
import { montarMensagem, type DetailReport } from "./notify-slack";

const base = (cenarios: DetailReport["cenarios"]): DetailReport => ({
  iniciado_em: "2026-06-01T06:00:00.000Z",
  duracao_ms: 1000,
  totais: { pass: 0, fail: 0, skip: 0, product_fail: 0, infra_fail: 0 },
  cenarios,
});

describe("montarMensagem", () => {
  it("sem problema quando tudo passa", () => {
    const { problema } = montarMensagem(base([{ nome: "01", status: "pass", classe: "pass" }]));
    expect(problema).toBe(false);
  });

  it("marca problema e lista fluxo quebrado com invariante", () => {
    const { problema, texto } = montarMensagem(base([
      { nome: "73 — Conversão NF", status: "fail", classe: "product-fail", invariantes: [{ nome: "I1: ledger↔cache", ok: false }, { nome: "I8: reservado↔ledger", ok: true }] },
    ]));
    expect(problema).toBe(true);
    expect(texto).toContain("73 — Conversão NF");
    expect(texto).toContain("I1: ledger↔cache");
  });

  it("infra-fail marca problema mas como inconclusivo", () => {
    const { problema, texto } = montarMensagem(base([
      { nome: "09 — Entrada direta", status: "fail", classe: "infra-fail" },
    ]));
    expect(problema).toBe(true);
    expect(texto).toContain("infra");
  });
});
