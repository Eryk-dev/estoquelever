import { describe, it, expect } from "vitest";
import { gerarCodigosLote, LOTE_MAX_TOTAL } from "./localizacoes";

describe("gerarCodigosLote", () => {
  it("caso canônico A-01-1 .. A-10-10 = 100 códigos", () => {
    const r = gerarCodigosLote({
      prefixo: "A",
      h_inicio: 1,
      h_fim: 10,
      v_inicio: 1,
      v_fim: 10,
    });
    expect(r.total).toBe(100);
    expect(r.codigos).toHaveLength(100);
    expect(r.codigos[0]).toBe("A-01-01");
    expect(r.codigos[r.codigos.length - 1]).toBe("A-10-10");
  });

  it("ordem: h externo, v interno", () => {
    const r = gerarCodigosLote({
      prefixo: "A",
      h_inicio: 1,
      h_fim: 2,
      v_inicio: 1,
      v_fim: 3,
    });
    expect(r.codigos).toEqual([
      "A-01-1",
      "A-01-2",
      "A-01-3",
      "A-02-1",
      "A-02-2",
      "A-02-3",
    ]);
  });

  it("prédio padded 2-dígitos, andar sem padding até 9", () => {
    const r = gerarCodigosLote({
      prefixo: "A",
      h_inicio: 1,
      h_fim: 5,
      v_inicio: 1,
      v_fim: 5,
    });
    expect(r.codigos[0]).toBe("A-01-1");
    expect(r.codigos[r.codigos.length - 1]).toBe("A-05-5");
  });

  it("prédio padding cresce quando fim > 99", () => {
    const r = gerarCodigosLote({
      prefixo: "A",
      h_inicio: 1,
      h_fim: 100,
      v_inicio: 1,
      v_fim: 5,
    });
    expect(r.codigos[0]).toBe("A-001-1");
    expect(r.codigos[r.codigos.length - 1]).toBe("A-100-5");
    expect(r.total).toBe(500);
  });

  it("andar > 9 vira 2 dígitos naturalmente", () => {
    const r = gerarCodigosLote({
      prefixo: "B",
      h_inicio: 1,
      h_fim: 10,
      v_inicio: 1,
      v_fim: 100,
    });
    expect(r.codigos[0]).toBe("B-01-001");
    expect(r.codigos[r.codigos.length - 1]).toBe("B-10-100");
  });

  it("range degenerado (1×1) gera 1 código", () => {
    const r = gerarCodigosLote({
      prefixo: "A",
      h_inicio: 5,
      h_fim: 5,
      v_inicio: 3,
      v_fim: 3,
    });
    expect(r.total).toBe(1);
    expect(r.codigos).toEqual(["A-05-3"]);
  });

  it("separador customizável", () => {
    const r = gerarCodigosLote({
      prefixo: "A",
      h_inicio: 1,
      h_fim: 1,
      v_inicio: 1,
      v_fim: 1,
      separador: ".",
    });
    expect(r.codigos[0]).toBe("A.01.1");
  });

  it("rejeita início > fim", () => {
    expect(() =>
      gerarCodigosLote({
        prefixo: "A",
        h_inicio: 10,
        h_fim: 1,
        v_inicio: 1,
        v_fim: 5,
      }),
    ).toThrow(/início não pode ser maior que fim/);
  });

  it("rejeita prefixo vazio", () => {
    expect(() =>
      gerarCodigosLote({
        prefixo: "",
        h_inicio: 1,
        h_fim: 1,
        v_inicio: 1,
        v_fim: 1,
      }),
    ).toThrow(/prefixo é obrigatório/);
  });

  it("rejeita prefixo com caractere inválido", () => {
    expect(() =>
      gerarCodigosLote({
        prefixo: "a-b",
        h_inicio: 1,
        h_fim: 1,
        v_inicio: 1,
        v_fim: 1,
      }),
    ).toThrow(/alfanuméricos maiúsculos/);
    expect(() =>
      gerarCodigosLote({
        prefixo: "AB CD",
        h_inicio: 1,
        h_fim: 1,
        v_inicio: 1,
        v_fim: 1,
      }),
    ).toThrow(/alfanuméricos maiúsculos/);
    expect(() =>
      gerarCodigosLote({
        prefixo: "TOOLONG12",
        h_inicio: 1,
        h_fim: 1,
        v_inicio: 1,
        v_fim: 1,
      }),
    ).toThrow(/alfanuméricos maiúsculos/);
  });

  it("rejeita total > LOTE_MAX_TOTAL", () => {
    expect(() =>
      gerarCodigosLote({
        prefixo: "A",
        h_inicio: 1,
        h_fim: 100,
        v_inicio: 1,
        v_fim: 100,
      }),
    ).toThrow(new RegExp(`lote excede ${LOTE_MAX_TOTAL}`));
  });

  it("rejeita valores não-inteiros / não-positivos", () => {
    expect(() =>
      gerarCodigosLote({
        prefixo: "A",
        h_inicio: 0,
        h_fim: 5,
        v_inicio: 1,
        v_fim: 5,
      }),
    ).toThrow(/inteiros positivos/);
    expect(() =>
      gerarCodigosLote({
        prefixo: "A",
        h_inicio: 1.5,
        h_fim: 5,
        v_inicio: 1,
        v_fim: 5,
      }),
    ).toThrow(/inteiros positivos/);
    expect(() =>
      gerarCodigosLote({
        prefixo: "A",
        h_inicio: -1,
        h_fim: 5,
        v_inicio: 1,
        v_fim: 5,
      }),
    ).toThrow(/inteiros positivos/);
  });
});
