import { describe, it, expect } from "vitest";
import { buildOcPayload, buildTransferenciaPayload, buildManualPayload } from "./receber-lote-adapters";
import type { ReceberLoteItem } from "./receber-lote-types";

function item(over: Partial<ReceberLoteItem>): ReceberLoteItem {
  return {
    uid: "u", produto: null, sku: "X", descricao: "x", imagem_url: null,
    backendItemId: "i1", qty: "3", qtyEsperada: 5, custo: "", locIdOverride: null,
    locCodigoOverride: null, imprimir: false, motivoDivergencia: null, ...over,
  };
}

describe("buildOcPayload", () => {
  it("manda item_id+qty_real; custo só se >0; motivo só se qty≠pendente", () => {
    const p = buildOcPayload([
      item({ backendItemId: "i1", qty: "3", qtyEsperada: 5, custo: "10", motivoDivergencia: "faltou" }),
    ]);
    expect(p.itens[0]).toEqual({
      item_id: "i1", qty_real: 3, custo_unitario: 10, motivo_divergencia: "faltou",
    });
  });
  it("sem divergência (qty=pendente) não manda motivo", () => {
    const p = buildOcPayload([item({ qty: "5", qtyEsperada: 5, motivoDivergencia: "faltou" })]);
    expect(p.itens[0].motivo_divergencia).toBeUndefined();
  });
});

describe("buildTransferenciaPayload", () => {
  it("manda transferencia_item_id + localizacao_destino_id, exige loc em todos", () => {
    const p = buildTransferenciaPayload([item({ backendItemId: "ti1", locIdOverride: "loc1" })]);
    expect(p.itens[0]).toEqual({ transferencia_item_id: "ti1", localizacao_destino_id: "loc1" });
    expect(() => buildTransferenciaPayload([item({ locIdOverride: null })])).toThrow(/loc/i);
  });
});

describe("buildManualPayload", () => {
  it("manda item_id+qty_recebida; custo só se preenchido; filtra qty<=0", () => {
    const p = buildManualPayload([
      item({ backendItemId: "mi1", qty: "2", custo: "7" }),
      item({ backendItemId: "mi2", qty: "0" }),
    ]);
    expect(p.itens).toEqual([{ item_id: "mi1", qty_recebida: 2, custo_unitario: 7 }]);
  });
});
