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

describe("reconciliarTemporal — múltiplas movs após contagem", () => {
  it("usa saldo_anterior da PRIMEIRA mov após T_ref (a cadeia se contém)", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 10, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 4, custo_medio: 10 },
      ],
      movs: [
        // saída 3 às T1 (saldo 10 → 7)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T1, saldo_anterior: 10, saldo_posterior: 7, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
        // saída 3 às T2 (saldo 7 → 4)
        { id: "m2", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T2, saldo_anterior: 7, saldo_posterior: 4, origem_tipo: "nf_venda", origem_id: "p2", estorno_de: null },
      ],
    });
    // saldo_esperado = saldo_anterior de m1 = 10 → delta = 10 - 10 = 0
    expect(out).toEqual([]);
  });
});

describe("reconciliarTemporal — estornos", () => {
  it("par estornado + sem movs reais: saldo_esperado = saldo_atual", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 7, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 7, custo_medio: 10 },
      ],
      movs: [
        // m1: saída de 3 (estornada depois)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T1, saldo_anterior: 7, saldo_posterior: 4, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
        // m2: estorno de m1
        { id: "m2", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T2, saldo_anterior: 4, saldo_posterior: 7, origem_tipo: "estorno", origem_id: "m1", estorno_de: "m1" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("ignora par estornado e usa mov posterior não-estornada", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 5, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 3, custo_medio: 10 },
      ],
      movs: [
        // m1: saída de 1 em T1 (estornada depois)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T1, saldo_anterior: 5, saldo_posterior: 4, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
        // m2: estorno de m1 em T2
        { id: "m2", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: "2026-05-18T13:11:00.000Z", saldo_anterior: 4, saldo_posterior: 5, origem_tipo: "estorno", origem_id: "m1", estorno_de: "m1" },
        // m3: saída posterior REAL de 2 (saldo 5 → 3)
        { id: "m3", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: "2026-05-18T13:15:00.000Z", saldo_anterior: 5, saldo_posterior: 3, origem_tipo: "nf_venda", origem_id: "p2", estorno_de: null },
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("reconciliarTemporal — movs da própria sessão", () => {
  it("ignora mov origem='inventario' com origem_id == sessao_id (caso re-aprovação)", () => {
    const out = reconciliarTemporal({
      sessao_id: "sess-1",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 5, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 5, custo_medio: 10 },
      ],
      movs: [
        // Mov de inventário aplicado pela MESMA sessão (em re-aprovação)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T1, saldo_anterior: 3, saldo_posterior: 5, origem_tipo: "inventario", origem_id: "sess-1", estorno_de: null },
      ],
    });
    // Ignora m1 → saldo_esperado = saldo_atual = 5 → delta = 0 → []
    expect(out).toEqual([]);
  });

  it("considera mov origem='inventario' de OUTRA sessão", () => {
    const out = reconciliarTemporal({
      sessao_id: "sess-1",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 3, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 5, custo_medio: 10 },
      ],
      movs: [
        { id: "m1", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T1, saldo_anterior: 3, saldo_posterior: 5, origem_tipo: "inventario", origem_id: "sess-OUTRA", estorno_de: null },
      ],
    });
    // m1 é considerada → saldo_esperado = 3 → delta = 0 → []
    expect(out).toEqual([]);
  });
});

describe("reconciliarTemporal — cutoff_em", () => {
  it("mov criada após cutoff_em é ignorada", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: T1, // cutoff antes da mov
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, qty_contada: 5, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, saldo: 2, custo_medio: 10 },
      ],
      movs: [
        // saída após cutoff
        { id: "m1", localizacao_id: LOC, produto_id: PROD, empresa_dona_id: DONA, criado_em: T2, saldo_anterior: 5, saldo_posterior: 2, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
      ],
    });
    // Mov após cutoff → ignorada → saldo_esperado=saldo_atual=2, qty=5, delta=+3
    expect(out).toEqual([
      {
        localizacao_id: LOC,
        produto_id: PROD,
        empresa_dona_id: DONA,
        saldo_esperado: 2,
        qty_contada_final: 5,
        delta: 3,
        valor_financeiro: 30,
      },
    ]);
  });
});
