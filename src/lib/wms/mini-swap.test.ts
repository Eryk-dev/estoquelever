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
