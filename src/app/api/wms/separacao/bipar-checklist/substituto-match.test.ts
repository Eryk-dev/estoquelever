import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regressão (troca de equivalência): o operador bipa o código da peça FÍSICA
 * (substituto). O item mantém o SKU vendido (D3) → o match por sku/gtin do item
 * NÃO casa; o fallback resolve via produto_wms_substituto_id. Sem ele, bipar a
 * peça que está em mãos dava "Nenhum item encontrado".
 */

const state = {
  // siso_pedido_itens
  porSku: [] as Array<Record<string, unknown>>,
  porGtin: [] as Array<Record<string, unknown>>,
  porSubstituto: [] as Array<Record<string, unknown>>,
  itemsFull: [] as Array<Record<string, unknown>>,
  // siso_produtos lookup do substituto
  produtoPorSku: [] as Array<{ id: string }>,
  produtoPorGtin: [] as Array<{ id: string }>,
  // siso_pedidos ctx
  pedidos: [] as Array<Record<string, unknown>>,
};

const rec = {
  itemUpdates: [] as Array<{ id: unknown; updates: Record<string, unknown> }>,
};

function makeBuilder(table: string) {
  const ops: Array<{ m: string; args: unknown[] }> = [];
  const has = (m: string) => ops.some((o) => o.m === m);
  const eqCol = (c: string) => ops.find((o) => o.m === "eq" && o.args[0] === c);
  const inCol = (c: string) => ops.some((o) => o.m === "in" && o.args[0] === c);
  const selStr = () => {
    const s = ops.find((o) => o.m === "select")?.args[0];
    return typeof s === "string" ? s : "";
  };

  const resolve = () => {
    if (table === "siso_produtos") {
      if (eqCol("sku")) return { data: state.produtoPorSku, error: null };
      if (eqCol("gtin")) return { data: state.produtoPorGtin, error: null };
      return { data: [], error: null };
    }
    if (table === "siso_pedidos") {
      return { data: state.pedidos, error: null };
    }
    if (table === "siso_pedido_itens") {
      if (has("update")) {
        const idEq = eqCol("id");
        rec.itemUpdates.push({
          id: idEq?.args[1],
          updates: ops.find((o) => o.m === "update")?.args[0] as Record<string, unknown>,
        });
        return { data: null, error: null };
      }
      if (inCol("produto_wms_substituto_id")) return { data: state.porSubstituto, error: null };
      if (eqCol("sku")) return { data: state.porSku, error: null };
      if (eqCol("gtin")) return { data: state.porGtin, error: null };
      if (inCol("id")) {
        // itemsFull (select com produto_id) vs final select (sem args)
        if (selStr().includes("produto_id")) return { data: state.itemsFull, error: null };
        return { data: state.itemsFull, error: null };
      }
      return { data: [], error: null };
    }
    return { data: [], error: null };
  };

  const builder: Record<string, unknown> = {};
  for (const m of ["update", "select", "eq", "in"]) {
    builder[m] = (...args: unknown[]) => {
      ops.push({ m, args });
      return builder;
    };
  }
  builder.then = (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF);
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));
vi.mock("@/lib/session", () => ({
  getSessionUser: () => Promise.resolve({ id: "u1", nome: "Eryk" }),
}));
const pickMovPicking = vi.fn(() => Promise.resolve({ movSaidaId: "S1" }));
vi.mock("@/lib/wms/separacao/pick-mov", () => ({
  pickMovPicking: (args: unknown) => pickMovPicking(args),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() },
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://x/api/wms/separacao/bipar-checklist", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  state.porSku = [];
  state.porGtin = [];
  state.porSubstituto = [];
  state.itemsFull = [];
  state.produtoPorSku = [];
  state.produtoPorGtin = [];
  state.pedidos = [];
  rec.itemUpdates = [];
  pickMovPicking.mockClear();
});

describe("bipar-checklist · match por substituto", () => {
  it("bipar o SKU do substituto casa o item via produto_wms_substituto_id e pica com o substituto", async () => {
    // item vendido GE5307, sem match por sku/gtin do scan EW004.309
    state.porSku = [];
    state.porGtin = [];
    // siso_produtos: EW004.309 → uuid do substituto
    state.produtoPorSku = [{ id: "sub-uuid" }];
    // fallback casa o item
    const item = { id: 1, pedido_id: "P1", sku: "GE5307", gtin: "111", compra_status: null };
    state.porSubstituto = [item];
    state.pedidos = [
      {
        id: "P1",
        numero: "145",
        empresa_origem_id: "e1",
        separacao_galpao_id: "g1",
        status_separacao: "aguardando_separacao",
      },
    ];
    state.itemsFull = [
      {
        id: 1,
        pedido_id: "P1",
        produto_id: 123,
        sku: "GE5307",
        quantidade_pedida: 1,
        quantidade_pega: 0,
        separacao_parcial: false,
        mov_saida_id: null,
        produto_wms_substituto_id: "sub-uuid",
      },
    ];

    const res = await POST(req({ sku: "EW004.309", pedido_ids: ["P1"] }));

    expect(res.status).toBe(200);
    // picou usando o substituto
    expect(pickMovPicking).toHaveBeenCalledTimes(1);
    expect(pickMovPicking.mock.calls[0][0]).toMatchObject({
      produto_wms_substituto_id: "sub-uuid",
      produto_id_tiny: "123",
    });
    // item marcado
    expect(rec.itemUpdates.some((u) => u.updates.separacao_marcado === true)).toBe(true);
  });

  it("scan que não casa nem item nem substituto → 404", async () => {
    state.porSku = [];
    state.porGtin = [];
    state.produtoPorSku = [];
    state.produtoPorGtin = [];
    state.porSubstituto = [];

    const res = await POST(req({ sku: "INEXISTENTE", pedido_ids: ["P1"] }));
    expect(res.status).toBe(404);
    expect(pickMovPicking).not.toHaveBeenCalled();
  });
});
