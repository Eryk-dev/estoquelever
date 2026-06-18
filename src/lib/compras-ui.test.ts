import { describe, it, expect } from "vitest";
import {
  flattenItensPorSku,
  agruparCompra,
  filtrarOrdenarLinhas,
  type ComprarItemLike,
  type CompraSelecionada,
  type LinhaCompra,
} from "./compras-ui";

function ped(over: Partial<ComprarItemLike["pedidos"][number]> = {}) {
  return {
    pedido_id: "p",
    item_id: "i",
    galpao_id: null as string | null,
    galpao_nome: null as string | null,
    aging_dias: 0,
    ...over,
  };
}

function item(over: Partial<ComprarItemLike> = {}): ComprarItemLike {
  return {
    sku: "X",
    quantidade_necessaria: 0,
    aging_dias: 0,
    pedidos: [],
    ...over,
  };
}

function linha(over: Partial<LinhaCompra> = {}): LinhaCompra {
  return {
    sku: "X",
    descricao: "",
    fornecedorNome: "Tiger",
    galpaoId: "sp",
    galpaoNome: "SP",
    quantidade: 1,
    aging_dias: 0,
    ...over,
  };
}

describe("flattenItensPorSku", () => {
  it("mesma SKU em 2 fornecedores vira 1 linha — mergeia pedidos, NÃO soma a qty", () => {
    const out = flattenItensPorSku([
      {
        itens: [
          item({
            sku: "A",
            quantidade_necessaria: 3,
            pedidos: [ped({ item_id: "i1" }), ped({ item_id: "i2" })],
          }),
        ],
      },
      {
        itens: [
          item({ sku: "A", quantidade_necessaria: 3, pedidos: [ped({ item_id: "i3" })] }),
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].quantidade_necessaria).toBe(3); // por-SKU global; não soma
    expect(out[0].pedidos.map((p) => p.item_id).sort()).toEqual(["i1", "i2", "i3"]);
  });

  it("não duplica o mesmo item_id ao mergear", () => {
    const out = flattenItensPorSku([
      { itens: [item({ sku: "A", pedidos: [ped({ item_id: "i1" })] })] },
      { itens: [item({ sku: "A", pedidos: [ped({ item_id: "i1" })] })] },
    ]);
    expect(out[0].pedidos).toHaveLength(1);
  });

  it("ordena por aging desc (mais antigo primeiro)", () => {
    const out = flattenItensPorSku([
      { itens: [item({ sku: "A", aging_dias: 1 }), item({ sku: "B", aging_dias: 9 })] },
    ]);
    expect(out.map((i) => i.sku)).toEqual(["B", "A"]);
  });
});

describe("filtrarOrdenarLinhas", () => {
  const linhas = [
    linha({ sku: "FOL-1", descricao: "Filtro óleo", fornecedorNome: "Tiger", galpaoId: "sp", quantidade: 4, aging_dias: 5 }),
    linha({ sku: "PAS-2", descricao: "Pastilha", fornecedorNome: "Cobreq", galpaoId: "cwb", quantidade: 6, aging_dias: 2 }),
    linha({ sku: "AMO-3", descricao: "Amortecedor", fornecedorNome: "Tiger", galpaoId: "cwb", quantidade: 1, aging_dias: 9 }),
  ];

  it("busca casa em sku, descrição ou fornecedor (case-insensitive)", () => {
    expect(filtrarOrdenarLinhas(linhas, { busca: "pastilha" }).map((l) => l.sku)).toEqual(["PAS-2"]);
    expect(filtrarOrdenarLinhas(linhas, { busca: "amo-3" }).map((l) => l.sku)).toEqual(["AMO-3"]);
    expect(filtrarOrdenarLinhas(linhas, { busca: "tiger" }).map((l) => l.sku).sort()).toEqual(["AMO-3", "FOL-1"]);
  });

  it("filtro por fornecedor", () => {
    expect(
      filtrarOrdenarLinhas(linhas, { fornecedor: "Cobreq" }).map((l) => l.sku),
    ).toEqual(["PAS-2"]);
  });

  it("filtro por galpão (id)", () => {
    expect(
      filtrarOrdenarLinhas(linhas, { galpao: "cwb", sortKey: "sku", sortDir: "asc" }).map((l) => l.sku),
    ).toEqual(["AMO-3", "PAS-2"]);
  });

  it("ordena por SKU asc", () => {
    expect(
      filtrarOrdenarLinhas(linhas, { sortKey: "sku", sortDir: "asc" }).map((l) => l.sku),
    ).toEqual(["AMO-3", "FOL-1", "PAS-2"]);
  });

  it("ordena por quanto desc", () => {
    expect(
      filtrarOrdenarLinhas(linhas, { sortKey: "quanto", sortDir: "desc" }).map((l) => l.quantidade),
    ).toEqual([6, 4, 1]);
  });

  it("default = urgência (aging) desc, mais antigo primeiro", () => {
    expect(filtrarOrdenarLinhas(linhas, {}).map((l) => l.sku)).toEqual(["AMO-3", "FOL-1", "PAS-2"]);
  });

  it("não muta o array de entrada", () => {
    const orig = [...linhas];
    filtrarOrdenarLinhas(linhas, { sortKey: "sku", sortDir: "asc" });
    expect(linhas).toEqual(orig);
  });
});

describe("agruparCompra", () => {
  const base: CompraSelecionada = {
    sku: "A",
    descricao: "",
    qty: 2,
    fornecedorNome: "Tiger",
    galpaoId: "sp",
    galpaoNome: "SP",
    custoUnitario: 10,
    pedidosCobertos: [{ numero: "1" }],
  };

  it("agrupa por fornecedor+galpão e soma qty/custo + une pedidos cobertos", () => {
    const g = agruparCompra([
      base,
      { ...base, sku: "B", qty: 3, custoUnitario: 5, pedidosCobertos: [{ numero: "2" }] },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].qtyTotal).toBe(5);
    expect(g[0].custoTotal).toBe(2 * 10 + 3 * 5);
    expect(g[0].pedidosCobertos.sort()).toEqual(["1", "2"]);
  });

  it("fornecedor OU galpão diferente → grupos diferentes", () => {
    const g = agruparCompra([base, { ...base, galpaoId: "cwb", galpaoNome: "CWB" }]);
    expect(g).toHaveLength(2);
  });

  it("custo null não corrompe o total (fica null)", () => {
    const g = agruparCompra([{ ...base, custoUnitario: null }]);
    expect(g[0].custoTotal).toBeNull();
  });
});
