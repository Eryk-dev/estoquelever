import { describe, it, expect } from "vitest";
import { sugerirLocalizacaoPutaway } from "./putaway";

interface ExistRow {
  localizacao_id: string;
  saldo: number;
  localizacao?: { codigo?: string; tipo?: string };
}

function mockSb(rows: ExistRow[], recebRows: { id: string; codigo: string }[] = []) {
  return {
    from(table: string) {
      if (table === "siso_estoque") {
        return {
          select: () => ({
            match: () => ({
              order: () => Promise.resolve({ data: rows, error: null }),
            }),
          }),
        };
      }
      if (table === "siso_localizacoes") {
        return {
          select: () => ({
            match: () => ({
              limit: () => Promise.resolve({ data: recebRows, error: null }),
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
    expect(r.localizacao_id).toBe("loc-A12");
    expect(r.razao).toMatch(/SKU já está/i);
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
    expect(r.localizacao_id).toBe("loc-picking");
  });

  it("retorna localização recebimento quando galpão não tem nada do SKU", async () => {
    const sb = mockSb([], [{ id: "loc-recv", codigo: "RECEBIMENTO" }]);
    const r = await sugerirLocalizacaoPutaway(sb as never, {
      produto_id: "p2",
      empresa_id: "e1",
      galpao_id: "g1",
    });
    expect(r.localizacao_id).toBe("loc-recv");
    expect(r.razao).toMatch(/recebimento/i);
  });
});
