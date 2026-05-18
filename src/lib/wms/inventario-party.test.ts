import { describe, it, expect } from "vitest";
import { decidirAcaoEntrada } from "./inventario";

describe("decidirAcaoEntrada", () => {
  it("retorna 'criar' quando não existe registro do usuário", () => {
    expect(decidirAcaoEntrada(null)).toEqual({ tipo: "criar" });
  });

  it("retorna 'no-op' quando o usuário já está ativo na party", () => {
    expect(
      decidirAcaoEntrada({ id: "op-1", finalizado_em: null }),
    ).toEqual({ tipo: "no-op" });
  });

  it("retorna 'reativar' quando o usuário saiu e está voltando", () => {
    expect(
      decidirAcaoEntrada({
        id: "op-1",
        finalizado_em: "2026-05-18T13:00:00.000Z",
      }),
    ).toEqual({ tipo: "reativar", id: "op-1" });
  });
});
