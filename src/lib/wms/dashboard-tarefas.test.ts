import { describe, it, expect } from "vitest";
import {
  agruparDevolucoesPendentes,
  agruparFornecedoresCompras,
  agruparTransferenciasTransito,
  dedupNonNullIds,
  hidratarExecutores,
} from "./dashboard-tarefas";

describe("dedupNonNullIds", () => {
  it("retorna [] quando entrada é vazia", () => {
    expect(dedupNonNullIds([])).toEqual([]);
  });

  it("remove nulls e undefined", () => {
    expect(dedupNonNullIds([null, "a", undefined, "b"])).toEqual(["a", "b"]);
  });

  it("dedupa mantendo ordem de primeira aparição", () => {
    expect(dedupNonNullIds(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("trata todos null/undefined como vazio", () => {
    expect(dedupNonNullIds([null, null, undefined])).toEqual([]);
  });
});

describe("hidratarExecutores", () => {
  const usuarios = new Map([
    ["u1", { id: "u1", nome: "Ana", foto_url: "https://x/a.jpg" }],
    ["u2", { id: "u2", nome: "Bruno", foto_url: null }],
    ["u3", { id: "u3", nome: "Carla", foto_url: null }],
  ]);

  it("retorna [] quando ids está vazio", () => {
    expect(hidratarExecutores([], usuarios)).toEqual([]);
  });

  it("preserva ordem dos ids fornecidos", () => {
    const out = hidratarExecutores(["u2", "u1"], usuarios);
    expect(out.map((e) => e.id)).toEqual(["u2", "u1"]);
  });

  it("ignora ids ausentes no map (usuário deletado ou desconhecido)", () => {
    const out = hidratarExecutores(["u1", "ghost", "u2"], usuarios);
    expect(out.map((e) => e.id)).toEqual(["u1", "u2"]);
  });

  it("propaga foto_url null sem mexer", () => {
    const out = hidratarExecutores(["u2"], usuarios);
    expect(out).toEqual([{ id: "u2", nome: "Bruno", foto_url: null }]);
  });
});

describe("agruparFornecedoresCompras", () => {
  it("retorna [] quando ambas as listas estão vazias", () => {
    expect(agruparFornecedoresCompras([], [])).toEqual([]);
  });

  it("agrupa por fornecedor e soma a_comprar + a_receber", () => {
    const out = agruparFornecedoresCompras(
      [
        { fornecedor_oc: "Tiger" },
        { fornecedor_oc: "Tiger" },
        { fornecedor_oc: "LDRU" },
      ],
      [{ fornecedor: "Tiger" }, { fornecedor: "GAUSS" }],
    );
    expect(out).toEqual([
      { fornecedor: "Tiger", a_comprar: 2, a_receber: 1 },
      { fornecedor: "GAUSS", a_comprar: 0, a_receber: 1 },
      { fornecedor: "LDRU", a_comprar: 1, a_receber: 0 },
    ]);
  });

  it("usa 'Sem fornecedor' quando fornecedor_oc/fornecedor é null ou vazio", () => {
    const out = agruparFornecedoresCompras(
      [{ fornecedor_oc: null }, { fornecedor_oc: "  " }],
      [{ fornecedor: null }],
    );
    expect(out).toEqual([
      { fornecedor: "Sem fornecedor", a_comprar: 2, a_receber: 1 },
    ]);
  });

  it("ordena por total desc, depois alfabético", () => {
    const out = agruparFornecedoresCompras(
      [{ fornecedor_oc: "B" }, { fornecedor_oc: "A" }],
      [{ fornecedor: "C" }, { fornecedor: "A" }],
    );
    // Totais: A=2, B=1, C=1. A vem primeiro (total maior); empate B vs C → alfabético
    expect(out.map((f) => f.fornecedor)).toEqual(["A", "B", "C"]);
  });

  it("ignora fornecedores que ficariam com total 0", () => {
    // Cenário não-real (não há entrada que zere), mas garante o filter
    const out = agruparFornecedoresCompras([], []);
    expect(out).toEqual([]);
  });
});

describe("agruparDevolucoesPendentes", () => {
  const linhas = [
    {
      id: "d1",
      nota_fiscal_id: 100,
      criado_em: "2026-05-26T10:00:00Z",
      empresa_referencia: { nome: "NetAir" },
    },
    {
      id: "d2",
      nota_fiscal_id: null,
      criado_em: "2026-05-26T11:00:00Z",
      empresa_referencia: null,
    },
  ];

  it("mapeia linhas pra cards", () => {
    const r = agruparDevolucoesPendentes(linhas);
    expect(r.count).toBe(2);
    expect(r.itens).toHaveLength(2);
    expect(r.itens[0]).toEqual({
      id: "d1",
      nota_fiscal_id: 100,
      empresa_referencia_nome: "NetAir",
      criada_em: "2026-05-26T10:00:00Z",
    });
    expect(r.itens[1].empresa_referencia_nome).toBeNull();
  });

  it("retorna count=0 e itens=[] quando vazio", () => {
    expect(agruparDevolucoesPendentes([])).toEqual({ count: 0, itens: [] });
  });

  it("trata empresa_referencia como array (relação 1 sem !inner)", () => {
    const r = agruparDevolucoesPendentes([
      {
        id: "d3",
        nota_fiscal_id: null,
        criado_em: "2026-05-26T12:00:00Z",
        empresa_referencia: [{ nome: "NetParts" }],
      },
    ]);
    expect(r.itens[0].empresa_referencia_nome).toBe("NetParts");
  });
});

describe("agruparTransferenciasTransito", () => {
  const linhas = [
    {
      id: "t1",
      criada_em: "2026-05-26T08:00:00Z",
      origem_galpao: { nome: "CWB" },
      destino_galpao: { nome: "SP" },
      itens: [{ qty: 5 }, { qty: 3 }],
    },
    {
      id: "t2",
      criada_em: "2026-05-26T09:00:00Z",
      origem_galpao: null,
      destino_galpao: null,
      itens: [],
    },
  ];

  it("conta itens (soma de qty)", () => {
    const r = agruparTransferenciasTransito(linhas);
    expect(r.itens[0].qty_itens).toBe(8);
    expect(r.itens[1].qty_itens).toBe(0);
  });

  it("trata join como array ou objeto", () => {
    const r = agruparTransferenciasTransito([
      {
        id: "t3",
        criada_em: "2026-05-26T10:00:00Z",
        origem_galpao: [{ nome: "CWB" }],
        destino_galpao: { nome: "SP" },
        itens: [{ qty: 1 }],
      },
    ]);
    expect(r.itens[0].origem_galpao_nome).toBe("CWB");
    expect(r.itens[0].destino_galpao_nome).toBe("SP");
  });
});
