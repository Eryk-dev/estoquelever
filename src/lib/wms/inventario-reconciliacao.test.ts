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

describe("reconciliarTemporal — sem movs após contagem", () => {
  it("contagem == saldo_atual → não emite divergência", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: T2,
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 5, contado_em: T1 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T1 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 5, custo_medio: 10 },
      ],
      movs: [],
    });
    expect(out).toEqual([]);
  });

  it("contagem != saldo_atual sem movs → emite divergência com saldo_atual", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: T2,
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 3, contado_em: T1 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T1 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 5, custo_medio: 10 },
      ],
      movs: [],
    });
    expect(out).toEqual([
      {
        localizacao_id: LOC,
        produto_id: PROD,
        empresa_dona_id: DONA,
        saldo_esperado: 5,
        qty_contada_final: 3,
        delta: -2,
        valor_financeiro: -20,
      },
    ]);
  });
});

describe("reconciliarTemporal — movs após contagem", () => {
  it("saída após contagem: saldo_esperado = saldo_anterior da mov", () => {
    // Reproduz o bug original: conta 1 às T1, picking sai 1 às T2, aprovação T_cutoff
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:20:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 1, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 0, custo_medio: 10 },
      ],
      movs: [
        {
          id: "m1",
          localizacao_id: LOC,
          produto_id: PROD,
          empresa_dona_id: DONA,
          criado_em: T1,
          saldo_anterior: 1,
          saldo_posterior: 0,
          origem_tipo: "nf_venda",
          origem_id: "pedido:91130001",
          estorno_de: null,
        },
      ],
    });
    expect(out).toEqual([]); // saldo_esperado = 1, qty = 1 → delta = 0 → vazio
  });

  it("entrada após contagem: saldo_esperado < saldo_atual", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:20:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 3, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 8, custo_medio: 10 },
      ],
      movs: [
        {
          id: "m2",
          localizacao_id: LOC,
          produto_id: PROD,
          empresa_dona_id: DONA,
          criado_em: T1,
          saldo_anterior: 3,
          saldo_posterior: 8,
          origem_tipo: "recebimento",
          origem_id: "guarda:abc",
          estorno_de: null,
        },
      ],
    });
    expect(out).toEqual([]); // saldo_esperado = 3, qty = 3 → delta = 0
  });
});
