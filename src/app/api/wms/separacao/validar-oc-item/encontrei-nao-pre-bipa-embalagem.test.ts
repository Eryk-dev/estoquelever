import { describe, it, expect, vi, beforeEach } from "vitest";

// Bug (2026-06-12, pedido #51261): "encontrei" na validação OC pré-marcava
// bipado_completo=true + quantidade_bipada=quantidade_pedida. O pedido caía
// na aba Separados já "Bipado", o bip do embalador retornava 404 "já bipado"
// e a etiqueta (disparada só dentro do bip que completa o pedido) nunca saía
// — o operador precisava reiniciar a embalagem e re-bipar tudo.
// Fix: encontrei marca só o PICK (separacao_marcado/quantidade_pega); o bip
// de embalagem fica pendente (bipado_completo=false, quantidade_bipada=0).

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Op" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn(() => ({ id: "e1", timestamp: "t" })),
  },
}));
vi.mock("@/lib/sku-fornecedor", () => ({
  getFornecedorBySku: () => ({ fornecedor: "FORN" }),
}));
vi.mock("@/lib/historico-service", () => ({
  registrarEvento: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wms/ledger", () => ({
  estornarMovimentacao: vi.fn(),
  inserirMovimentacao: vi.fn(),
}));
vi.mock("@/lib/separacao/wms-mapping", () => ({
  resolverProdutoWms: vi.fn(async () => "prod-uuid"),
  resolverLocalizacaoWms: vi.fn(async () => "loc-uuid"),
}));
vi.mock("@/lib/wms/contagem-inline", () => ({
  registrarContagemInline: vi.fn(),
  enfileirarLocParaContagem: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wms/separacao/alocacao-contagem", () => ({
  alocarContagem: vi.fn(() => new Map()),
}));

const { pickMovSpy } = vi.hoisted(() => ({
  pickMovSpy: vi.fn(async () => ({ movSaidaId: "mov-s1" })),
}));
vi.mock("@/lib/wms/separacao/pick-mov", () => ({ pickMovPicking: pickMovSpy }));

// supabase fake: thenable chain que resolve por (tabela, operação, nº da
// chamada). Updates capturados em `updates` pra asserts de payload.
const tables: { itens: unknown[]; itensFull: unknown[]; pedidosCtx: unknown[] } = {
  itens: [],
  itensFull: [],
  pedidosCtx: [],
};
const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
const selectCount: Record<string, number> = {};

function dataFor(table: string, nth: number, single: boolean): unknown {
  if (table === "siso_pedido_itens") {
    // 1ª select = items; 2ª = itensFull; 3ª = allItems (transição)
    if (nth === 1) return tables.itens;
    if (nth === 2) return tables.itensFull;
    return [{ id: 1, compra_status: null, separacao_marcado: true }];
  }
  if (table === "siso_pedidos") {
    // 1ª = pedidosCtx (array); 2ª = pedido .single()
    if (nth === 1) return tables.pedidosCtx;
    return single
      ? { id: "p1", status_separacao: "validacao_oc", decisao_final: "oc" }
      : [];
  }
  if (table === "siso_estoque") {
    // produto tem loc com saldo → caminho normal (sem "encontrei sem cadastro")
    return [{ localizacao_id: "loc1" }];
  }
  return [];
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      let op = "select";
      let single = false;
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "in", "eq", "neq", "not", "delete", "gt", "limit"]) {
        chain[m] = () => {
          if (m === "delete") op = m;
          return chain;
        };
      }
      chain.update = (payload: Record<string, unknown>) => {
        op = "update";
        updates.push({ table, payload });
        return chain;
      };
      chain.single = () => {
        single = true;
        return chain;
      };
      chain.maybeSingle = chain.single;
      chain.then = (resolve: (v: unknown) => void) => {
        if (op !== "select") {
          resolve({ data: null, error: null });
          return;
        }
        const key = `${table}:select`;
        selectCount[key] = (selectCount[key] ?? 0) + 1;
        resolve({ data: dataFor(table, selectCount[key], single), error: null });
      };
      return chain;
    },
  }),
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

function makeReq(body: unknown): NextRequest {
  return new Request("http://x/api/wms/separacao/validar-oc-item", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(selectCount)) delete selectCount[k];
  updates.length = 0;
  tables.itens = [
    {
      id: 1,
      pedido_id: "p1",
      sku: "CAR006-1",
      quantidade_pedida: 4,
      quantidade_pega: 0,
      compra_status: "oc_pendente",
      fornecedor_oc: null,
    },
  ];
  tables.itensFull = [
    {
      id: 1,
      pedido_id: "p1",
      produto_id: "915088409",
      sku: "CAR006-1",
      quantidade_pedida: 4,
      mov_saida_id: null,
    },
  ];
  tables.pedidosCtx = [
    { id: "p1", numero: "51261", empresa_origem_id: "e1", separacao_galpao_id: "g1" },
  ];
});

describe("validar-oc-item encontrei — não pré-marca bip de embalagem", () => {
  it("marca o pick mas deixa bipado_completo=false / quantidade_bipada=0", async () => {
    const res = await POST(makeReq({ item_ids: ["1"], acao: "encontrei" }));
    expect(res.status).toBe(200);

    expect(pickMovSpy).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 1, qty: 4, contexto: "encontrei_oc" }),
    );

    const itemUpdate = updates.find(
      (u) => u.table === "siso_pedido_itens" && "separacao_marcado" in u.payload,
    );
    expect(itemUpdate).toBeDefined();
    expect(itemUpdate!.payload).toMatchObject({
      separacao_marcado: true,
      quantidade_pega: 4,
      mov_saida_id: "mov-s1",
      bipado_completo: false,
      quantidade_bipada: 0,
    });
  });
});
