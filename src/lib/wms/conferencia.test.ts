import { describe, it, expect } from "vitest";
import {
  ehChaveNf,
  escaparLike,
  derivarCandidatos,
  extrairRunsDigitos,
  tirarPrefixoAim,
} from "./conferencia";

// QR real da etiqueta ML (visto no staging): o payload é um JSON com o shipment
// id. O mesmo id fica guardado em etiqueta_barcodes também como Code128 cru, e
// é por ele que casamos quando o JSON do QR não bate (garble de teclado / encode
// de array do PostgREST).
const QR_ML = '{"id":"47362139627","t":"lm"}';
const SHIPMENT = "47362139627";
const CHAVE = "41260634857388000163550030001760601464538389"; // 44 díg

describe("tirarPrefixoAim", () => {
  it("remove identificador AIM de QR (]Q1)", () => {
    expect(tirarPrefixoAim(`]Q1${QR_ML}`)).toBe(QR_ML);
  });
  it("remove ]C0 de Code128", () => {
    expect(tirarPrefixoAim("]C0" + SHIPMENT)).toBe(SHIPMENT);
  });
  it("não mexe em valor sem prefixo", () => {
    expect(tirarPrefixoAim(SHIPMENT)).toBe(SHIPMENT);
    expect(tirarPrefixoAim(QR_ML)).toBe(QR_ML);
  });
});

describe("extrairRunsDigitos", () => {
  it("pega o shipment id de dentro do QR JSON", () => {
    expect(extrairRunsDigitos(QR_ML)).toEqual([SHIPMENT]);
  });
  it("pega o id mesmo com o JSON garbleado por teclado ABNT2", () => {
    // chaves/aspas/: trocadas, dígitos intactos
    expect(extrairRunsDigitos("ç´id´:´47362139627´,´t´:´lm´")).toEqual([SHIPMENT]);
  });
  it("garble REAL do leitor (ABNT2): {\"\":^  :→Ç  }→{", () => {
    // String exata capturada do bipador do Eryk pro QR {"id":"47347380136","t":"lm"}
    expect(extrairRunsDigitos("^id^Ç^47347380136^,^t^Ç^lm^{")).toEqual(["47347380136"]);
  });
  it("ignora runs curtos (<8)", () => {
    expect(extrairRunsDigitos("ab12 cd345")).toEqual([]);
  });
  it("pega a chave NF de 44 dígitos", () => {
    expect(extrairRunsDigitos(CHAVE)).toEqual([CHAVE]);
  });
});

describe("derivarCandidatos", () => {
  it("QR JSON limpo → inclui o shipment id (casa o Code128 guardado)", () => {
    const c = derivarCandidatos(QR_ML);
    expect(c).toContain(QR_ML);
    expect(c).toContain(SHIPMENT);
  });

  it("QR com prefixo AIM → tira o prefixo E extrai o id", () => {
    const c = derivarCandidatos(`]Q1${QR_ML}`);
    expect(c).toContain(QR_ML); // versão sem AIM
    expect(c).toContain(SHIPMENT);
  });

  it("QR garbleado por teclado → ainda extrai o shipment id", () => {
    const c = derivarCandidatos("ç´id´:´47362139627´,´t´:´lm´");
    expect(c).toContain(SHIPMENT);
  });

  it("garble REAL do leitor → shipment id (casa pedido 1046419115 no staging)", () => {
    const c = derivarCandidatos("^id^Ç^47347380136^,^t^Ç^lm^{");
    expect(c).toContain("47347380136");
  });

  it("Code128 cru passa direto", () => {
    expect(derivarCandidatos(SHIPMENT)).toContain(SHIPMENT);
  });

  it("extrai id do JSON mesmo se não-numérico", () => {
    const c = derivarCandidatos('{"id":"AB12CD34","t":"lm"}');
    expect(c).toContain("AB12CD34");
  });

  it("dedup — sem repetidos", () => {
    const c = derivarCandidatos(SHIPMENT);
    expect(c.filter((x) => x === SHIPMENT)).toHaveLength(1);
  });

  it("vazio → []", () => {
    expect(derivarCandidatos("")).toEqual([]);
    expect(derivarCandidatos("   ")).toEqual([]);
  });
});

describe("ehChaveNf", () => {
  it("aceita exatamente 44 dígitos", () => {
    expect(ehChaveNf("35260634857388000163550010000123451000123456")).toBe(true);
  });
  it("rejeita 43/45 dígitos, letras e vazio", () => {
    expect(ehChaveNf("3526063485738800016355001000012345100012345")).toBe(false);
    expect(ehChaveNf("352606348573880001635500100001234510001234567")).toBe(false);
    expect(ehChaveNf("35260634857388000163550010000123451000123abc")).toBe(false);
    expect(ehChaveNf("")).toBe(false);
  });
});

describe("escaparLike", () => {
  it("escapa % _ e backslash", () => {
    expect(escaparLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
  it("código normal passa intacto", () => {
    expect(escaparLike("BR251400123456X")).toBe("BR251400123456X");
  });
});
