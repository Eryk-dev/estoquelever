import { describe, it, expect, vi } from "vitest";

// A page é "use client" — mocka as deps de runtime pra importar as funções puras.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: null }), sisoFetch: vi.fn() }));
vi.mock("@/hooks/use-realtime-separacao", () => ({ useRealtimeSeparacao: () => {} }));
vi.mock("@/hooks/use-presenca-wms", () => ({ useTrackPresencaWms: () => {} }));

import { ordenar, consolidar } from "../page";

type Row = Parameters<typeof ordenar>[0][number];
type Item = Parameters<typeof consolidar>[0][number];

function cp(over: Partial<Row> & { sku: string }): Row {
  return {
    key: over.sku,
    produto_id: over.sku,
    gtin: null,
    descricao: over.sku,
    imagem_url: null,
    imagens: [],
    localizacao: null,
    empresa_origem_id: null,
    separacao_galpao_id: null,
    quantidade_total: 1,
    quantidade_restante: 1,
    quantidade_pega: 0,
    all_marcado: false,
    item_ids: [],
    is_oc: false,
    compra_status: null,
    saldo: 1,
    disponivel: 1,
    locs_disponiveis: 1,
    ordem_full: null,
    ...over,
  };
}

function item(over: Partial<Item> & { id: string; produto_id: string }): Item {
  return {
    pedido_id: "P1",
    sku: over.produto_id,
    gtin: null,
    descricao: over.produto_id,
    quantidade: 1,
    separacao_marcado: false,
    separacao_marcado_em: null,
    localizacao: null,
    imagem_url: null,
    imagens: [],
    empresa_origem_id: null,
    separacao_galpao_id: null,
    saldo: 1,
    disponivel: 1,
    locs_disponiveis: 1,
    galpao_nome: null,
    compra_status: null,
    quantidade_pega: null,
    separacao_parcial: false,
    parcial_motivo: null,
    parcial_em: null,
    realocacoes: [],
    ordem_full: null,
    ...over,
  };
}

describe("ordenar — modo 'ordem' (ordem do pedido)", () => {
  it("ordena asc por ordem_full (inseridos 3,1,2 → 1,2,3)", () => {
    const out = ordenar([cp({ sku: "C", ordem_full: 3 }), cp({ sku: "A", ordem_full: 1 }), cp({ sku: "B", ordem_full: 2 })], "ordem");
    expect(out.map((p) => p.ordem_full)).toEqual([1, 2, 3]);
    expect(out.map((p) => p.sku)).toEqual(["A", "B", "C"]);
  });

  it("itens sem ordem_full (null) vão pro fim", () => {
    const out = ordenar([cp({ sku: "X", ordem_full: null }), cp({ sku: "A", ordem_full: 1 }), cp({ sku: "B", ordem_full: 2 })], "ordem");
    expect(out.map((p) => p.sku)).toEqual(["A", "B", "X"]);
  });

  it("empates preservam ordem de entrada (estável)", () => {
    const out = ordenar([cp({ sku: "primeiro", ordem_full: 1 }), cp({ sku: "segundo", ordem_full: 1 })], "ordem");
    expect(out.map((p) => p.sku)).toEqual(["primeiro", "segundo"]);
  });
});

describe("ordenar — regressão dos modos existentes", () => {
  const rows = [cp({ sku: "banana", descricao: "Zebra", localizacao: "B-02", ordem_full: 1 }), cp({ sku: "abacaxi", descricao: "Alfa", localizacao: "A-01", ordem_full: 2 })];
  it("sku continua alfabético", () => {
    expect(ordenar(rows, "sku").map((p) => p.sku)).toEqual(["abacaxi", "banana"]);
  });
  it("descricao continua alfabético", () => {
    expect(ordenar(rows, "descricao").map((p) => p.descricao)).toEqual(["Alfa", "Zebra"]);
  });
  it("localizacao continua por endereço", () => {
    expect(ordenar(rows, "localizacao").map((p) => p.localizacao)).toEqual(["A-01", "B-02"]);
  });
});

describe("consolidar — chave de ordem = menor ordem_full do bucket", () => {
  it("mesmo produto de 2 pedidos com ordem_full 5 e 2 → bucket ganha 2", () => {
    const { itensNormais } = consolidar([
      item({ id: "1", produto_id: "999", ordem_full: 5 }),
      item({ id: "2", produto_id: "999", ordem_full: 2 }),
    ]);
    expect(itensNormais).toHaveLength(1);
    expect(itensNormais[0].ordem_full).toBe(2);
  });
});
