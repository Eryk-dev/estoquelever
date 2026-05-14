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
