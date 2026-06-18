import { describe, it, expect, vi, beforeEach } from "vitest";

// Captura os args de cada inserirMovimentacao pra inspecionar o custo_unitario gravado.
const movCalls: Array<{ custo_unitario?: number; tipo: string }> = [];

vi.mock("@/lib/wms/ledger", () => ({
  inserirMovimentacao: vi.fn(async (input: { custo_unitario?: number; tipo: string }) => {
    movCalls.push({ custo_unitario: input.custo_unitario, tipo: input.tipo });
    return { id: "mov-" + movCalls.length };
  }),
  estornarMovimentacao: vi.fn(),
}));

// guarda/crossdock/release/registrar não relevantes ao custo — stubs.
vi.mock("@/lib/wms/guarda", () => ({
  resolverLocRecebimento: vi.fn(async () => ({ id: "loc-receb" })),
  criarPendencia: vi.fn(async () => "pend-1"),
}));
vi.mock("@/lib/separacao/wms-mapping", () => ({
  resolverProdutoWms: vi.fn(async () => "prod-uuid"),
  resolverProdutoWmsFlex: vi.fn(async () => "prod-uuid"),
}));
// split sem cross-dock: toda a qty vira guarda normal (1 pendência).
vi.mock("@/lib/wms/crossdock-detector", () => ({
  detectarCrossDock: vi.fn(async () => ({
    qty_cross_dock: 0, qty_guarda_normal: 5, loc_packing_id: null, pedidos_vinculados: [],
  })),
}));
vi.mock("@/lib/compras-release", () => ({ checkAndReleasePedidos: vi.fn(async () => ({})) }));
vi.mock("@/lib/historico-service", () => ({ registrarEvento: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), logError: vi.fn() } }));

// supabase: OC achada; item achado; custo médio histórico = 9; update otimista devolve 1 linha.
vi.mock("@/lib/supabase-server", () => {
  const oc = { id: "oc-1", galpao_id: "g1", fornecedor: null, empresa_id: "e1" };
  const item = {
    id: "item-1", pedido_id: "ped-1", sku: "SKU1", produto_id: "tiny-1",
    compra_quantidade_solicitada: 5, compra_quantidade_recebida: 0, ordem_compra_id: "oc-1",
  };
  // chain de SELECT: .select().eq()...; .single() devolve oc/item; .maybeSingle() devolve
  // custo médio (siso_custo_medio) ou null (fornecedor). Suporta N .eq() encadeados.
  function selectChain(table: string) {
    const node: Record<string, unknown> = {
      eq: () => node,
      is: () => node,
      single: async () => ({ data: table === "siso_ordens_compra" ? oc : item, error: null }),
      maybeSingle: async () =>
        table === "siso_custo_medio" ? { data: { custo_medio: 9 }, error: null } : { data: null, error: null },
      // update otimista termina em .select("id") → devolve 1 linha.
      select: async () => ({ data: [{ id: "item-1" }], error: null }),
    };
    return node;
  }
  const client = {
    from: (table: string) => ({
      select: () => selectChain(table),
      update: () => selectChain(table), // .update().eq().eq().select("id")
    }),
  };
  return { createServiceClient: () => client };
});

import { receberItensViaOC } from "./receber-oc";

describe("receber-oc — wiring do fallback de custo no call-site real", () => {
  beforeEach(() => { movCalls.length = 0; });

  it("grava a mov E com o custo RESOLVIDO (fallback histórico 9) quando o item vem SEM custo", async () => {
    await receberItensViaOC({
      ocId: "oc-1",
      itens: [{ item_id: "item-1", qty_real: 5 }], // custo_unitario ausente
      operadorId: "op-1",
      operadorNome: "Op",
    });
    const movE = movCalls.find((m) => m.tipo === "E");
    expect(movE).toBeDefined();
    // RED antes do fix: gravaria undefined (itemReq.custo_unitario). GREEN: fallback 9.
    expect(movE?.custo_unitario).toBe(9);
  });
});
