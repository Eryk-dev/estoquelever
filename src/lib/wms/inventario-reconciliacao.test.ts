import { describe, it, expect } from "vitest";
import { reconciliarTemporal } from "./inventario-reconciliacao";

const T0 = "2026-05-18T13:00:00.000Z";
const T1 = "2026-05-18T13:05:00.000Z";
const T2 = "2026-05-18T13:10:00.000Z";

const LOC = "loc-1";
const PROD = "prod-1";

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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 5, contado_em: T1 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T1 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 5, custo_medio: 10 },
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 3, contado_em: T1 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T1 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 5, custo_medio: 10 },
      ],
      movs: [],
    });
    expect(out).toEqual([
      {
        localizacao_id: LOC,
        produto_id: PROD,
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 1, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 0, custo_medio: 10 },
      ],
      movs: [
        {
          id: "m1",
          localizacao_id: LOC,
          produto_id: PROD,
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 3, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 8, custo_medio: 10 },
      ],
      movs: [
        {
          id: "m2",
          localizacao_id: LOC,
          produto_id: PROD,
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 10, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 4, custo_medio: 10 },
      ],
      movs: [
        // saída 3 às T1 (saldo 10 → 7)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T1, saldo_anterior: 10, saldo_posterior: 7, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
        // saída 3 às T2 (saldo 7 → 4)
        { id: "m2", localizacao_id: LOC, produto_id: PROD, criado_em: T2, saldo_anterior: 7, saldo_posterior: 4, origem_tipo: "nf_venda", origem_id: "p2", estorno_de: null },
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 7, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 7, custo_medio: 10 },
      ],
      movs: [
        // m1: saída de 3 (estornada depois)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T1, saldo_anterior: 7, saldo_posterior: 4, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
        // m2: estorno de m1
        { id: "m2", localizacao_id: LOC, produto_id: PROD, criado_em: T2, saldo_anterior: 4, saldo_posterior: 7, origem_tipo: "estorno", origem_id: "m1", estorno_de: "m1" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("ignora par estornado e usa mov posterior não-estornada", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 5, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 3, custo_medio: 10 },
      ],
      movs: [
        // m1: saída de 1 em T1 (estornada depois)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T1, saldo_anterior: 5, saldo_posterior: 4, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
        // m2: estorno de m1 em T2
        { id: "m2", localizacao_id: LOC, produto_id: PROD, criado_em: "2026-05-18T13:11:00.000Z", saldo_anterior: 4, saldo_posterior: 5, origem_tipo: "estorno", origem_id: "m1", estorno_de: "m1" },
        // m3: saída posterior REAL de 2 (saldo 5 → 3)
        { id: "m3", localizacao_id: LOC, produto_id: PROD, criado_em: "2026-05-18T13:15:00.000Z", saldo_anterior: 5, saldo_posterior: 3, origem_tipo: "nf_venda", origem_id: "p2", estorno_de: null },
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 5, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 5, custo_medio: 10 },
      ],
      movs: [
        // Mov de inventário aplicado pela MESMA sessão (em re-aprovação)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T1, saldo_anterior: 3, saldo_posterior: 5, origem_tipo: "inventario", origem_id: "sess-1", estorno_de: null },
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 3, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 5, custo_medio: 10 },
      ],
      movs: [
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T1, saldo_anterior: 3, saldo_posterior: 5, origem_tipo: "inventario", origem_id: "sess-OUTRA", estorno_de: null },
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
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 5, contado_em: T0 },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T0 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 2, custo_medio: 10 },
      ],
      movs: [
        // saída após cutoff
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T2, saldo_anterior: 5, saldo_posterior: 2, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
      ],
    });
    // Mov após cutoff → ignorada → saldo_esperado=saldo_atual=2, qty=5, delta=+3
    expect(out).toEqual([
      {
        localizacao_id: LOC,
        produto_id: PROD,
        saldo_esperado: 2,
        qty_contada_final: 5,
        delta: 3,
        valor_financeiro: 30,
      },
    ]);
  });
});

describe("reconciliarTemporal — loc visitada vazia", () => {
  it("loc visitada sem contagens + entrada após visita → não emite divergência", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [], // operador encerrou sem bipar (confirmou modal "vazia")
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T1 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 3, custo_medio: 10 },
      ],
      movs: [
        // Entrada DEPOIS da visita — não conta como sumiço
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T2, saldo_anterior: 0, saldo_posterior: 3, origem_tipo: "recebimento", origem_id: "g1", estorno_de: null },
      ],
    });
    expect(out).toEqual([]);
  });

  it("loc visitada sem contagens + saldo > 0 SEM entrada após visita → divergência qty=0", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T2 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 3, custo_medio: 10 },
      ],
      movs: [], // saldo é antigo, persiste desde antes da sessão
    });
    expect(out).toEqual([
      {
        localizacao_id: LOC,
        produto_id: PROD,
        saldo_esperado: 3,
        qty_contada_final: 0,
        delta: -3,
        valor_financeiro: -30,
      },
    ]);
  });
});

describe("reconciliarTemporal — loc não visitada", () => {
  it("loc sem entry em locs_visitadas + sem contagens → sempre ignorada", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [],
      locs_visitadas: [], // nenhuma loc finalizada
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 99, custo_medio: 10 },
      ],
      movs: [],
    });
    expect(out).toEqual([]);
  });
});

describe("reconciliarTemporal — múltiplas contagens da mesma quádrupla", () => {
  it("soma qtys e usa max(contado_em) como T_ref", () => {
    const out = reconciliarTemporal({
      sessao_id: "s",
      cutoff_em: "2026-05-18T13:30:00.000Z",
      contagens: [
        // Mesma quádrupla bipada 3 vezes (caso edge: dois operadores)
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 2, contado_em: T0 },
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 1, contado_em: T1 },
        { localizacao_id: LOC, produto_id: PROD, qty_contada: 1, contado_em: "2026-05-18T13:07:00.000Z" },
      ],
      locs_visitadas: [{ localizacao_id: LOC, contagem_finalizada_em: T1 }],
      saldos_atuais: [
        { localizacao_id: LOC, produto_id: PROD, saldo: 2, custo_medio: 10 },
      ],
      movs: [
        // Saída de 2 depois da última contagem (T_ref = T1)
        { id: "m1", localizacao_id: LOC, produto_id: PROD, criado_em: T2, saldo_anterior: 4, saldo_posterior: 2, origem_tipo: "nf_venda", origem_id: "p1", estorno_de: null },
      ],
    });
    // qty agregada = 2+1+1 = 4. T_ref = T1 (max). Primeira mov após T1 é m1, saldo_anterior=4.
    // delta = 4 - 4 = 0 → []
    expect(out).toEqual([]);
  });
});

describe("reconciliarTemporal — regressão: bug do item 001233 (sessão 6282e654)", () => {
  it("contagem → picking → cutoff: ZERO divergência (antes era +1 fake)", () => {
    // Replay literal:
    //   18:08:30  conta 1 unidade
    //   18:10:36  picking sai 1 (saldo 1→0) origem=nf_venda pedido:91130001
    //   18:13:28  aprovação (cutoff)
    const T_CONT = "2026-05-18T18:08:30.000Z";
    const T_PICK = "2026-05-18T18:10:36.000Z";
    const T_CUTOFF = "2026-05-18T18:13:28.000Z";

    const out = reconciliarTemporal({
      sessao_id: "6282e654-f778-4a11-9d47-4b1ec12ad9a4",
      cutoff_em: T_CUTOFF,
      contagens: [
        { localizacao_id: "e64758ac-028e-4471-9150-e202f72d1cf6", produto_id: "59c90d29-7a04-40b9-9f8e-47e8756b0eec", qty_contada: 1, contado_em: T_CONT },
      ],
      locs_visitadas: [{ localizacao_id: "e64758ac-028e-4471-9150-e202f72d1cf6", contagem_finalizada_em: T_CONT }],
      saldos_atuais: [
        { localizacao_id: "e64758ac-028e-4471-9150-e202f72d1cf6", produto_id: "59c90d29-7a04-40b9-9f8e-47e8756b0eec", saldo: 0, custo_medio: 25 },
      ],
      movs: [
        { id: "2bf9a187", localizacao_id: "e64758ac-028e-4471-9150-e202f72d1cf6", produto_id: "59c90d29-7a04-40b9-9f8e-47e8756b0eec", criado_em: T_PICK, saldo_anterior: 1, saldo_posterior: 0, origem_tipo: "nf_venda", origem_id: "pedido:91130001", estorno_de: null },
      ],
    });
    expect(out).toEqual([]);
  });
});
