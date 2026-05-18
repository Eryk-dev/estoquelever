import { describe, it, expect } from "vitest";
import { reconciliarTemporal } from "./inventario-reconciliacao";

const T0 = "2026-05-18T13:00:00.000Z";
const T1 = "2026-05-18T13:05:00.000Z";
const T2 = "2026-05-18T13:10:00.000Z";

const LOC = "loc-1";
const PROD = "prod-1";
const DONA = "dona-1";

describe("reconciliarTemporal — smoke", () => {
  it("retorna array vazio quando não há contagens nem locs visitadas", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: T2,
      contagens: [],
      locs_visitadas: [],
      saldos_atuais: [],
      movs: [],
    });
    expect(out).toEqual([]);
  });
});
