import { describe, it, expect } from "vitest";
import {
  buildOcPayload,
  buildTransferenciaPayload,
  buildManualPayload,
  buildCompraPayload,
  splitOcExtras,
} from "./receber-lote-adapters";
import type { ReceberLoteItem } from "./receber-lote-types";

function item(over: Partial<ReceberLoteItem>): ReceberLoteItem {
  return {
    uid: "u", produto: null, sku: "X", descricao: "x", imagem_url: null,
    backendItemId: "i1", qty: "3", qtyEsperada: 5, custo: "", locIdOverride: null,
    locCodigoOverride: null, imprimir: false, motivoDivergencia: null, produtoWmsId: null, ...over,
  };
}

describe("buildOcPayload", () => {
  it("manda item_id+qty_real; custo só se >0; motivo só se qty≠pendente", () => {
    const p = buildOcPayload(
      [item({ backendItemId: "i1", qty: "3", qtyEsperada: 5, custo: "10", motivoDivergencia: "faltou" })],
      { entradaDireta: false },
    );
    expect(p.itens[0]).toEqual(
      expect.objectContaining({ item_id: "i1", qty_real: 3, custo_unitario: 10, motivo_divergencia: "faltou" }),
    );
  });
  it("sem divergência (qty=pendente) não manda motivo", () => {
    const p = buildOcPayload(
      [item({ qty: "5", qtyEsperada: 5, motivoDivergencia: "faltou" })],
      { entradaDireta: false },
    );
    expect(p.itens[0].motivo_divergencia).toBeUndefined();
  });
});

describe("buildOcPayload v2", () => {
  it("filtra qty<=0 (item da OC que não veio) e inclui loc por item", () => {
    const p = buildOcPayload(
      [
        item({ backendItemId: "i1", qty: "3", qtyEsperada: 5, locIdOverride: "loc1" }),
        item({ backendItemId: "i2", qty: "0", qtyEsperada: 2 }),
      ],
      { entradaDireta: true, nfReferencia: "NF-123" },
    );
    expect(p.itens).toHaveLength(1);
    expect(p.itens[0]).toEqual(
      expect.objectContaining({ item_id: "i1", qty_real: 3, localizacao_destino_id: "loc1" }),
    );
    expect(p.entrada_direta).toBe(true);
    expect(p.nf_referencia).toBe("NF-123");
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
    const p = buildManualPayload(
      [
        item({ backendItemId: "mi1", qty: "2", custo: "7" }),
        item({ backendItemId: "mi2", qty: "0" }),
      ],
      { entradaDireta: false },
    );
    expect(p.itens).toEqual([{ item_id: "mi1", qty_recebida: 2, custo_unitario: 7 }]);
  });
});

describe("buildManualPayload v2", () => {
  it("inclui loc por item e flag entrada_direta", () => {
    const p = buildManualPayload(
      [item({ backendItemId: "mi1", qty: "2", locIdOverride: "loc9" })],
      { entradaDireta: false },
    );
    expect(p.itens[0]).toEqual(
      expect.objectContaining({ item_id: "mi1", qty_recebida: 2, localizacao_destino_id: "loc9" }),
    );
    expect(p.entrada_direta).toBe(false);
  });
});

describe("buildCompraPayload", () => {
  it("monta body de criação de compra a partir de linhas com produto resolvido", () => {
    const prod = { id: "uuid-p1", sku: "ABC", descricao: "x" } as never;
    const p = buildCompraPayload(
      [item({ produto: prod, qty: "4", custo: "12.5", backendItemId: null })],
      { fornecedorId: "f1", empresaId: "e1", galpaoId: "g1", observacao: "obs" },
    );
    expect(p).toEqual({
      fornecedor_id: "f1", empresa_compradora_id: "e1", galpao_id: "g1", observacao: "obs",
      itens: [{ produto_id: "uuid-p1", qty_comprada: 4, custo_unitario: 12.5 }],
    });
  });
  it("custo vazio vira undefined (opcional no endpoint)", () => {
    const prod = { id: "uuid-p1" } as never;
    const p = buildCompraPayload(
      [item({ produto: prod, qty: "1", custo: "" })],
      { fornecedorId: "f1", empresaId: "e1", galpaoId: "g1", observacao: null },
    );
    expect(p.itens[0].custo_unitario).toBeUndefined();
  });
});

describe("splitOcExtras", () => {
  it("separa linhas da OC (backendItemId) das extras (produto sem backendItemId)", () => {
    const prod = { id: "uuid-p9" } as never;
    const { ocItens, extras } = splitOcExtras([
      item({ backendItemId: "i1" }),
      item({ backendItemId: null, produto: prod, qty: "2" }),
      item({ backendItemId: null, produto: null }), // linha vazia ignorada
    ]);
    expect(ocItens).toHaveLength(1);
    expect(extras).toHaveLength(1);
  });
});
