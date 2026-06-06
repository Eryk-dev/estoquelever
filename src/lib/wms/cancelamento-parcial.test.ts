import { describe, it, expect } from "vitest";
import { classificarItensParaCancelamento } from "./cancelamento-parcial";

describe("classificarItensParaCancelamento", () => {
  it("separa pego (mov_saida_id != null) de não-pego", () => {
    const r = classificarItensParaCancelamento([
      { id: "i1", sku: "SKU-A", mov_saida_id: "mov-1", quantidade_pega: 1 },
      { id: "i2", sku: "SKU-B", mov_saida_id: null, quantidade_pega: null },
    ]);
    expect(r.pegos.map((i) => i.id)).toEqual(["i1"]);
    expect(r.naoPegos.map((i) => i.id)).toEqual(["i2"]);
  });

  it("item com quantidade_pega>0 mas sem mov_saida_id ainda conta como pego (parcial em curso)", () => {
    const r = classificarItensParaCancelamento([
      { id: "i3", sku: "SKU-C", mov_saida_id: null, quantidade_pega: 2 },
    ]);
    expect(r.pegos.map((i) => i.id)).toEqual(["i3"]);
    expect(r.naoPegos).toEqual([]);
  });

  it("lista vazia → ambos vazios", () => {
    const r = classificarItensParaCancelamento([]);
    expect(r.pegos).toEqual([]);
    expect(r.naoPegos).toEqual([]);
  });
});
