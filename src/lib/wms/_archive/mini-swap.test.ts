// ARCHIVED 2026-05-20 — see docs/superpowers/archive/README.md
// This module is no longer imported anywhere. Kept as reference for the
// 4D ownership model in case it gets resurrected.
import { describe, it, expect } from "vitest";
import { planejarMiniSwap } from "./mini-swap";
import type { EstadoEstoqueSku, Demanda } from "./mini-swap-types";

describe("planejarMiniSwap — caso base", () => {
  it("skipa SKU quando empresa picadora já está em 1 loc só", () => {
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "PROD1",
        galpao_id: "GAL_CWB",
        linhas: [
          { empresa_dona_id: "NETAIR", localizacao_id: "LOC_A", localizacao_codigo: "A-03-02", saldo: 5, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LOC_C", localizacao_codigo: "C-05-04", saldo: 8, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [
      { empresa_picadora_id: "NETAIR", produto_id: "PROD1", qty_total: 5, qty_emprestimo_planejada: 0, reservas_existentes_ids: [] },
    ];

    const plano = planejarMiniSwap({ galpao_id: "GAL_CWB", pedido_ids: ["PED1"], estado, demandas });

    expect(plano.demandas_planejadas).toHaveLength(0);
    expect(plano.demandas_skipadas).toEqual([{ produto_id: "PROD1", motivo: "ja_consolidado" }]);
  });
});

describe("planejarMiniSwap — swap puro", () => {
  it("planeja swap puro quando picadora tem contrapartida total nas outras locs", () => {
    // NetAir: 3 em A, 2 em B. NetParts: 5 em C. Demanda NetAir = 5 (zero empréstimo).
    // Esperado: swap 5 unidades — NetAir entrega 5 (3 em A + 2 em B), NetParts entrega 5 em C.
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "PROD1",
        galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 3, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [
      { empresa_picadora_id: "NETAIR", produto_id: "PROD1", qty_total: 5, qty_emprestimo_planejada: 0, reservas_existentes_ids: [] },
    ];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });

    expect(plano.demandas_planejadas).toHaveLength(1);
    const d = plano.demandas_planejadas[0];
    expect(d.loc_destino_id).toBe("LC");
    expect(d.qty_swap).toBe(5);
    expect(d.qty_emprestimo).toBe(0);
    // 3 ops: NetAir saída em A (3), NetAir saída em B (2), NetParts saída em C (5) — emparelhadas como swap par
    // Modelo: 1 op por loc envolvida. Ver detalhes na nota abaixo.
    expect(d.swaps).toHaveLength(3);
    const totalSwap = d.swaps.reduce((s, op) => s + op.qty, 0);
    // N+1 ops: 2 origem (picadora→F: 3+2) + 1 destino (F→picadora: 5) = 10 total qty
    expect(totalSwap).toBe(10);
  });
});

describe("planejarMiniSwap — híbrido swap+empréstimo", () => {
  it("usa swap parcial + empréstimo quando picadora não tem contrapartida total", () => {
    // NetAir: 2 em A, 1 em B. NetParts: 5 em C. Demanda NetAir = 5, empréstimo planejado = 2.
    // Picadora tem contrapartida 3 (2+1). Cobertura: swap 3 + empréstimo 2 = 5 ✅
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 1, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 2, reservas_existentes_ids: ["R1"] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    const d = plano.demandas_planejadas[0];
    expect(d.loc_destino_id).toBe("LC");
    expect(d.qty_swap).toBe(3);
    expect(d.qty_emprestimo).toBe(2);
    expect(d.emprestimos[0].qty).toBe(2);
    expect(d.reservas_a_cancelar).toEqual(["R1"]);
  });

  it("NÃO excede qty_emprestimo_planejada do roteamento", () => {
    // Cenário onde algoritmo poderia teoricamente pedir mais empréstimo, mas DEVE respeitar o limite.
    // NetAir: 1 em A. NetParts: 10 em C. Demanda NetAir = 5, empréstimo planejado = 2.
    // Sem mini-swap: picadora cobre 1 + empréstimo 2 = 3 (insuficiente!) — esse cenário não deveria existir
    // Isso significa que o roteamento errou — mini-swap NÃO conserta isso, skipa.
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 1, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 10, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 2, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    expect(plano.demandas_planejadas).toHaveLength(0);
    expect(plano.demandas_skipadas[0].motivo).toBe("ja_consolidado");
    // (já está em 1 loc só — picadora tem só LA)
  });
});

describe("planejarMiniSwap — casos inviáveis", () => {
  it("skipa quando nenhuma loc cabe Q total via swap+empréstimo", () => {
    // NetAir: 2 em A, 2 em B. NetParts: 3 em C. Demanda 5, empréstimo planejado = 1.
    // Capacidade em C: swap_max=min(4, 3)=3 + emp_max=min(1, 3-3)=0 = 3 < 5 ✗
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 3, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 1, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    expect(plano.demandas_planejadas).toHaveLength(0);
    expect(plano.demandas_skipadas[0].motivo).toBe("nenhuma_loc_viavel");
  });

  it("escolhe a loc candidata com maior capacidade quando há múltiplas viáveis", () => {
    // NetAir: 3 em A, 2 em B. NetParts: 5 em C. Multi: 5 em D.
    // Ambas C e D viáveis. Algoritmo prefere por maior saldo (ordem decrescente) → D primeiro (saldo 6).
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 3, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LD", localizacao_codigo: "D", saldo: 6, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 0, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    expect(plano.demandas_planejadas[0].loc_destino_id).toBe("LD"); // maior saldo (6)
  });
});

describe("planejarMiniSwap — invariantes", () => {
  it("preserva saldo total por empresa após executar plano (simulação)", () => {
    const estado: EstadoEstoqueSku[] = [
      {
        produto_id: "P1", galpao_id: "G1",
        linhas: [
          { empresa_dona_id: "NETAIR",   localizacao_id: "LA", localizacao_codigo: "A", saldo: 2, reservado: 0 },
          { empresa_dona_id: "NETAIR",   localizacao_id: "LB", localizacao_codigo: "B", saldo: 1, reservado: 0 },
          { empresa_dona_id: "NETPARTS", localizacao_id: "LC", localizacao_codigo: "C", saldo: 5, reservado: 0 },
        ],
      },
    ];
    const demandas: Demanda[] = [{ empresa_picadora_id: "NETAIR", produto_id: "P1", qty_total: 5, qty_emprestimo_planejada: 2, reservas_existentes_ids: [] }];

    const plano = planejarMiniSwap({ galpao_id: "G1", pedido_ids: ["P1"], estado, demandas });
    const d = plano.demandas_planejadas[0];

    // Simular aplicação dos swaps: cada op é S na origem + E no destino, qtys iguais
    const saldosFinais = new Map<string, number>();
    for (const linha of estado[0].linhas) {
      saldosFinais.set(linha.empresa_dona_id, (saldosFinais.get(linha.empresa_dona_id) ?? 0) + linha.saldo);
    }
    // Aplicar swaps: empresa_origem -qty, empresa_destino +qty (PURO swap, não conta empréstimo)
    for (const op of d.swaps) {
      saldosFinais.set(op.empresa_origem_id, saldosFinais.get(op.empresa_origem_id)! - op.qty);
      saldosFinais.set(op.empresa_destino_id, saldosFinais.get(op.empresa_destino_id)! + op.qty);
    }
    // Conservação: NetAir e NetParts mantêm saldo total
    expect(saldosFinais.get("NETAIR")).toBe(3); // 2+1+0
    expect(saldosFinais.get("NETPARTS")).toBe(5); // só na C
  });
});
