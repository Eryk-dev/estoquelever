/**
 * ml-notifications — webhook do ML promove a futura em tempo real quando a
 * etiqueta libera (substatus deixa de ser buffered).
 *
 * Mock: supabase (chain), ml-api (conexão + status by id), promoverPedidoFutura.
 * classificarPromocaoFutura é puro → usado de verdade.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabase-server", () => ({ createServiceClient: vi.fn() }));
vi.mock("./ml-api", () => ({
  getActiveMlConnectionForEmpresa: vi.fn(),
  getMlShipmentStatusById: vi.fn(),
}));
vi.mock("./webhook-processor-wms", () => ({
  promoverPedidoFutura: vi.fn(async () => ({ enfileirouLancamento: true })),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createServiceClient } from "./supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  getMlShipmentStatusById,
} from "./ml-api";
import { promoverPedidoFutura } from "./webhook-processor-wms";
import {
  processMlNotification,
  parseShipmentIdFromResource,
} from "./ml-notifications";

// Chain mock: cada método encadeável volta o próprio builder; maybeSingle resolve.
function chain(result: { data: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "not", "order", "limit", "is"]) {
    b[m] = () => b;
  }
  b.maybeSingle = async () => result;
  b.single = async () => result;
  return b;
}
function makeSb(byTable: Record<string, unknown>) {
  return {
    from: (t: string) => chain({ data: byTable[t] ?? null }),
  } as unknown as ReturnType<typeof createServiceClient>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseShipmentIdFromResource", () => {
  it("extrai o id de /shipments/N e variações", () => {
    expect(parseShipmentIdFromResource("/shipments/47331508924")).toBe("47331508924");
    expect(parseShipmentIdFromResource("/shipments/123/history")).toBe("123");
    expect(parseShipmentIdFromResource("/orders/9")).toBeNull();
    expect(parseShipmentIdFromResource(null)).toBeNull();
    expect(parseShipmentIdFromResource(undefined)).toBeNull();
  });
});

describe("processMlNotification", () => {
  it("ignora tópico != shipments sem tocar no banco", async () => {
    const r = await processMlNotification({ topic: "orders_v2", resource: "/orders/1" });
    expect(r).toEqual({ handled: false, reason: "ignored_topic" });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(promoverPedidoFutura).not.toHaveBeenCalled();
  });

  it("resource sem shipment id → no_shipment_id", async () => {
    const r = await processMlNotification({ topic: "shipments", resource: "/shipments/abc" });
    expect(r.reason).toBe("no_shipment_id");
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("etiqueta liberou (ready_to_print) → promove a futura", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({
        siso_pedidos: {
          id: "P1",
          decisao_final: "propria",
          empresa_origem_id: "E1",
          separacao_galpao_id: "G1",
        },
        siso_galpoes: { nome: "CWB" },
      }),
    );
    vi.mocked(getActiveMlConnectionForEmpresa).mockResolvedValue("conn1");
    vi.mocked(getMlShipmentStatusById).mockResolvedValue({
      status: "ready_to_ship",
      substatus: "ready_to_print",
    });

    const r = await processMlNotification({
      topic: "shipments",
      resource: "/shipments/999",
      user_id: 421259712,
    });

    expect(r).toEqual({ handled: true, reason: "promovido", pedidoId: "P1" });
    expect(promoverPedidoFutura).toHaveBeenCalledWith(expect.anything(), {
      pedidoId: "P1",
      decisaoFinal: "propria",
      galpaoNome: "CWB",
      empresaId: "E1",
    });
  });

  it("ainda buffered → mantém, não promove", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({
        siso_pedidos: {
          id: "P2",
          decisao_final: "propria",
          empresa_origem_id: "E1",
          separacao_galpao_id: "G1",
        },
        siso_galpoes: { nome: "CWB" },
      }),
    );
    vi.mocked(getActiveMlConnectionForEmpresa).mockResolvedValue("conn1");
    vi.mocked(getMlShipmentStatusById).mockResolvedValue({
      status: "ready_to_ship",
      substatus: "buffered",
    });

    const r = await processMlNotification({ topic: "shipments", resource: "/shipments/888" });
    expect(r).toEqual({ handled: true, reason: "mantido", pedidoId: "P2" });
    expect(promoverPedidoFutura).not.toHaveBeenCalled();
  });

  it("shipment sem futura viva nossa → pedido_nao_encontrado", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeSb({ siso_pedidos: null }));

    const r = await processMlNotification({ topic: "shipments", resource: "/shipments/777" });
    expect(r.reason).toBe("pedido_nao_encontrado");
    expect(promoverPedidoFutura).not.toHaveBeenCalled();
  });
});
