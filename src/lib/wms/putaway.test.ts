import { describe, it, expect } from "vitest";
import { sugerirLocalizacaoPutaway } from "./putaway";

interface ExistRow {
  localizacao_id: string;
  saldo: number;
  localizacao?: { codigo?: string; tipo?: string };
}

function mockSb(
  rows: ExistRow[],
  defaultPickingRows: { id: string; codigo: string }[] = [],
) {
  return {
    from(table: string) {
      if (table === "siso_estoque") {
        return {
          select: () => ({
            match: () => ({
              gt: () => ({
                order: () => Promise.resolve({ data: rows, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "siso_localizacoes") {
        return {
          select: () => ({
            match: () => ({
              limit: () =>
                Promise.resolve({ data: defaultPickingRows, error: null }),
            }),
          }),
        };
      }
      return {} as never;
    },
  };
}

describe("sugerirLocalizacaoPutaway", () => {
  it("retorna localização com saldo do mesmo SKU se existir", async () => {
    const sb = mockSb([
      {
        localizacao_id: "loc-A12",
        saldo: 50,
        localizacao: { codigo: "A12", tipo: "picking" },
      },
    ]);
    const r = await sugerirLocalizacaoPutaway(sb as never, {
      produto_id: "p1",
      empresa_id: "e1",
      galpao_id: "g1",
    });
    expect(r?.localizacao_id).toBe("loc-A12");
    expect(r?.razao).toMatch(/SKU já está/i);
  });

  it("prefere localização picking sobre overstock quando ambas têm saldo", async () => {
    const sb = mockSb([
      {
        localizacao_id: "loc-overstock",
        saldo: 200,
        localizacao: { codigo: "OVR", tipo: "overstock" },
      },
      {
        localizacao_id: "loc-picking",
        saldo: 30,
        localizacao: { codigo: "A1", tipo: "picking" },
      },
    ]);
    const r = await sugerirLocalizacaoPutaway(sb as never, {
      produto_id: "p1",
      empresa_id: "e1",
      galpao_id: "g1",
    });
    expect(r?.localizacao_id).toBe("loc-picking");
  });

  it("NUNCA sugere loc tipo='recebimento' mesmo se SKU tiver saldo só lá", async () => {
    // Cenário: SKU foi recebido mas ainda não guardado (saldo só em RECEBIMENTO).
    // Sugerir RECEBIMENTO como destino do put-away causaria erro "destino==origem".
    const sb = mockSb(
      [
        {
          localizacao_id: "loc-recv",
          saldo: 10,
          localizacao: { codigo: "RECEBIMENTO", tipo: "recebimento" },
        },
      ],
      [{ id: "loc-default", codigo: "DEFAULT-PICKING" }],
    );
    const r = await sugerirLocalizacaoPutaway(sb as never, {
      produto_id: "p2",
      empresa_id: "e1",
      galpao_id: "g1",
    });
    expect(r?.localizacao_id).toBe("loc-default");
  });

  it("retorna null quando SKU novo e galpão não tem DEFAULT-PICKING", async () => {
    const sb = mockSb([], []);
    const r = await sugerirLocalizacaoPutaway(sb as never, {
      produto_id: "p2",
      empresa_id: "e1",
      galpao_id: "g1",
    });
    expect(r).toBeNull();
  });

  it("cai pra DEFAULT-PICKING quando SKU não tem saldo em loc não-recebimento", async () => {
    const sb = mockSb(
      [],
      [{ id: "loc-default", codigo: "DEFAULT-PICKING" }],
    );
    const r = await sugerirLocalizacaoPutaway(sb as never, {
      produto_id: "p2",
      empresa_id: "e1",
      galpao_id: "g1",
    });
    expect(r?.localizacao_id).toBe("loc-default");
    expect(r?.razao).toMatch(/DEFAULT-PICKING/i);
  });
});
