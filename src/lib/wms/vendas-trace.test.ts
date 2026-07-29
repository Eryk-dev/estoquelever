import { describe, expect, it } from "vitest";
import {
  calcularSaidasVendaPorItem,
  classificarVendaItem,
  quantidadeMovimentoPorItem,
  quantidadeProcessadaVenda,
  resumirItensVenda,
} from "./vendas-trace";

describe("rastreabilidade de itens de vendas", () => {
  it("reconhece item Full marcado como separado mesmo sem quantidade_bipada", () => {
    const item = {
      quantidade_pedida: 28,
      quantidade_pega: 28,
      quantidade_bipada: 0,
      separacao_marcado: true,
    };

    expect(quantidadeProcessadaVenda(item)).toBe(28);
    expect(classificarVendaItem(item)).toMatchObject({
      key: "separado",
      label: "Separado",
    });
  });

  it("mantém parcial visível quando só parte da quantidade saiu", () => {
    const item = {
      quantidade_pedida: 6,
      quantidade_pega: 5,
      separacao_parcial: true,
      estoque_saida_lancada: true,
    };

    expect(quantidadeProcessadaVenda(item)).toBe(5);
    expect(classificarVendaItem(item)).toMatchObject({
      key: "parcial",
      tone: "warn",
    });
  });

  it("resume progresso e exceções item a item", () => {
    expect(
      resumirItensVenda([
        { quantidade_pedida: 10, quantidade_pega: 10, separacao_marcado: true },
        { quantidade_pedida: 6, quantidade_pega: 5, separacao_parcial: true },
        { quantidade_pedida: 2, compra_status: "solicitado" },
      ]),
    ).toEqual({
      itens_total: 3,
      itens_processados: 1,
      itens_com_excecao: 2,
      unidades_total: 18,
      unidades_processadas: 15,
    });
  });

  it("deriva baixa direta pelas saídas do ledger mesmo sem campos de picking", () => {
    const items = [
      {
        id: 11,
        sku: "SKU-DIRETA",
        quantidade_pedida: 7,
        quantidade_pega: null,
        quantidade_bipada: 0,
      },
    ];
    const saidas = calcularSaidasVendaPorItem(items, [
      {
        id: "mov-a",
        tipo: "S",
        quantidade: 4,
        origem_detalhes: { pedido_id_manual: "MAN-1", sku: "SKU-DIRETA" },
      },
      {
        id: "mov-b",
        tipo: "S",
        quantidade: 3,
        origem_detalhes: { pedido_id_manual: "MAN-1", sku: "SKU-DIRETA" },
      },
    ]);
    const itemComLedger = {
      ...items[0],
      quantidade_baixada_movimentos: saidas.get("11"),
    };

    expect(saidas.get("11")).toBe(7);
    expect(quantidadeProcessadaVenda(itemComLedger)).toBe(7);
    expect(classificarVendaItem(itemComLedger)).toMatchObject({
      key: "baixado",
      label: "Baixado",
    });
  });

  it("prefere link.qty à quantidade global de uma saída compartilhada", () => {
    expect(quantidadeMovimentoPorItem(10, 2)).toBe(2);

    const items = [
      { id: 21, sku: "SKU-A", quantidade_pedida: 2 },
      { id: 22, sku: "SKU-B", quantidade_pedida: 8 },
    ];
    const saidas = calcularSaidasVendaPorItem(
      items,
      [{ id: "mov-compartilhada", tipo: "S", quantidade: 10 }],
      [
        {
          pedido_item_id: 21,
          mov_id: "mov-compartilhada",
          qty: 2,
          tipo_link: "saida",
        },
        {
          pedido_item_id: 22,
          mov_id: "mov-compartilhada",
          qty: 8,
          tipo_link: "saida",
        },
      ],
    );

    expect(saidas).toEqual(new Map([["21", 2], ["22", 8]]));
  });

  it("não inventa rateio de saída sem vínculo entre linhas Full do mesmo SKU", () => {
    const items = [
      { id: 31, sku: "SKU-REPETIDO", quantidade_pedida: 2 },
      { id: 32, sku: "SKU-REPETIDO", quantidade_pedida: 3 },
    ];
    const saidas = calcularSaidasVendaPorItem(items, [
      {
        id: "mov-sem-vinculo",
        tipo: "S",
        quantidade: 5,
        origem_detalhes: { sku: "SKU-REPETIDO" },
      },
    ]);

    expect(saidas).toEqual(new Map([["31", 0], ["32", 0]]));
  });

  it("ignora saída totalmente estornada", () => {
    const items = [{ id: 41, sku: "SKU-CANCELADO", quantidade_pedida: 1 }];
    const saidas = calcularSaidasVendaPorItem(items, [
      {
        id: "mov-saida",
        tipo: "S",
        quantidade: 1,
        origem_detalhes: { sku: "SKU-CANCELADO" },
      },
      {
        id: "mov-estorno",
        tipo: "E",
        quantidade: 1,
        estorno_de: "mov-saida",
      },
    ]);

    expect(saidas.get("41")).toBe(0);
  });

  it("preserva a fração viva de uma saída compartilhada com estorno parcial", () => {
    const items = [
      { id: 51, sku: "SKU-A", quantidade_pedida: 2 },
      { id: 52, sku: "SKU-B", quantidade_pedida: 8 },
    ];
    const saidas = calcularSaidasVendaPorItem(
      items,
      [
        {
          id: "mov-wave",
          tipo: "S",
          quantidade: 10,
          qty_estornada: 2,
        },
        {
          id: "estorno-item-a",
          tipo: "E",
          quantidade: 2,
          estorno_de: "mov-wave",
          origem_detalhes: { parcial: true, pedido_item_id: 51 },
        },
      ],
      [
        {
          pedido_item_id: 51,
          mov_id: "mov-wave",
          qty: 2,
          tipo_link: "saida",
        },
        {
          pedido_item_id: 52,
          mov_id: "mov-wave",
          qty: 8,
          tipo_link: "saida",
        },
      ],
    );

    expect(saidas).toEqual(new Map([["51", 0], ["52", 8]]));
  });
});
