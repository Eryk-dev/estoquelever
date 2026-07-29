import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: "validacao_oc",
  compraStatus: null as string | null,
  pick: vi.fn(async (_args: unknown) => ({
    mov_l_id: "mov-l",
    mov_s_id: "mov-s",
  })),
}));

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Operador" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn(() => ({ id: "e1", timestamp: "t1" })),
  },
}));
vi.mock("@/lib/wms/reservas-picking", () => ({
  buscarReservaPendentePorProduto: async () => ({
    id: "reserva-1",
    produto_id: "produto-wms",
    galpao_id: "g1",
    localizacao_id: "loc1",
    quantidade: 70,
  }),
  pickItemAtomico: (args: unknown) => h.pick(args),
}));
vi.mock("@/lib/separacao/wms-mapping", () => ({
  buscarLocComMaiorSaldoNoGalpao: vi.fn(),
}));
vi.mock("@/lib/wms/sync-tiny", () => ({
  resolverProdutoEfetivoComAutoSync: async () => "produto-wms",
}));

function fakeClient() {
  return {
    from(table: string) {
      let operation: "select" | "update" | "insert" = "select";
      let updatePayload: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.insert = () => {
        operation = "insert";
        return chain;
      };
      chain.update = (payload: Record<string, unknown>) => {
        operation = "update";
        updatePayload = payload;
        return chain;
      };
      chain.single = async () => {
        if (table === "siso_pedido_itens" && operation === "select") {
          return {
            data: {
              id: 13203,
              pedido_id: "FULL-1",
              produto_id: 928922691,
              sku: "FRM012",
              quantidade_pedida: 70,
              quantidade_pega: null,
              separacao_parcial: false,
              mov_saida_id: null,
              produto_wms_substituto_id: null,
              compra_status: h.compraStatus,
            },
            error: null,
          };
        }
        if (table === "siso_pedidos") {
          return {
            data: {
              id: "FULL-1",
              numero: "FULL-1",
              empresa_origem_id: "e1",
              separacao_galpao_id: "g1",
              status_separacao: h.status,
            },
            error: null,
          };
        }
        return {
          data: { id: 13203, ...updatePayload },
          error: null,
        };
      };
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve);
      return chain;
    },
  };
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => fakeClient(),
}));

import { POST } from "./route";

function request() {
  return new Request("http://x/api/wms/separacao/marcar-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pedido_item_id: 13203, marcado: true }),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  h.status = "validacao_oc";
  h.compraStatus = null;
  h.pick.mockClear();
});

describe("marcar-item durante validação OC", () => {
  it("permite picar o item normal restante com sua reserva viva", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(h.pick).toHaveBeenCalledWith(
      expect.objectContaining({
        reserva_id: "reserva-1",
        qty: 70,
        pedido_id: "FULL-1",
      }),
    );
  });

  it("continua bloqueando status terminal", async () => {
    h.status = "separado";

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(h.pick).not.toHaveBeenCalled();
  });

  it("não deixa o checkbox comum pular a decisão Encontrei/Esgotado", async () => {
    h.compraStatus = "oc_pendente";

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "validacao_oc_requer_decisao",
    });
    expect(h.pick).not.toHaveBeenCalled();
  });
});
