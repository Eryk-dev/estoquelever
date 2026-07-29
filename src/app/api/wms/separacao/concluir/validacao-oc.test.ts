import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  claimCompra: true,
  statusFilters: [] as string[][],
}));

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Operador" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn(),
  },
}));
vi.mock("@/lib/historico-service", () => ({
  registrarEventos: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agrupamento-service", () => ({
  preCriarAgrupamentosEmLote: vi.fn(async () => undefined),
  recarregarEtiquetasFaltantes: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wms/cutover", () => ({
  dispararCutoverSePronto: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      let operation: "select" | "update" = "select";
      let updatePayload: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};

      chain.select = () => chain;
      chain.update = (payload: Record<string, unknown>) => {
        operation = "update";
        updatePayload = payload;
        return chain;
      };
      chain.eq = () => chain;
      chain.in = (column: string, values: unknown[]) => {
        if (column === "status_separacao") {
          state.statusFilters.push(values.map(String));
        }
        return chain;
      };
      chain.then = (resolve: (value: unknown) => unknown) => {
        if (table === "siso_pedido_itens" && operation === "select") {
          return Promise.resolve({
            data: [
              {
                id: 1,
                pedido_id: "p1",
                separacao_marcado: true,
                compra_status: null,
                compra_quantidade_solicitada: 0,
                compra_quantidade_recebida: 0,
                sku: "NORMAL",
              },
              {
                id: 2,
                pedido_id: "p1",
                separacao_marcado: false,
                compra_status: "aguardando_compra",
                compra_quantidade_solicitada: 1,
                compra_quantidade_recebida: 0,
                sku: "OC",
              },
            ],
            error: null,
          }).then(resolve);
        }
        if (
          table === "siso_pedido_item_realocacoes" &&
          operation === "select"
        ) {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        }
        if (
          table === "siso_pedidos" &&
          operation === "update" &&
          updatePayload.status_separacao === "aguardando_compra"
        ) {
          return Promise.resolve({
            data: state.claimCompra ? [{ id: "p1" }] : [],
            error: null,
          }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      };
      return chain;
    },
  }),
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

function request(): NextRequest {
  return new Request("http://x/api/wms/separacao/concluir", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pedido_ids: ["p1"] }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  state.claimCompra = true;
  state.statusFilters.length = 0;
});

describe("concluir pedido que veio de validação OC", () => {
  it("aceita validacao_oc como origem para aguardando_compra", async () => {
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(state.statusFilters).toContainEqual([
      "em_separacao",
      "validacao_oc",
    ]);
    expect(body.aguardandoCompra).toEqual(["p1"]);
    expect(body.nao_concluidos).toEqual([]);
  });

  it("não responde sucesso falso quando o status não foi atualizado", async () => {
    state.claimCompra = false;

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.aguardandoCompra).toEqual([]);
    expect(body.nao_concluidos).toEqual([
      {
        pedido_id: "p1",
        motivo: "status_inesperado_aguardando_compra",
      },
    ]);
  });
});
