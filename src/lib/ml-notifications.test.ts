/**
 * ml-notifications — webhook do ML em 2 caminhos:
 *  - intake (orders_v2): carrega futura buffered ainda não vista
 *  - promoção (shipments): promove quando a etiqueta libera
 *
 * Mocks: supabase (chain por tabela), ml-api, empresa-lookup, tiny-oauth,
 * tiny-queue, tiny-api, processWebhook, promoverPedidoFutura.
 * classificarPromocaoFutura + SUBSTATUS_FUTURA são puros → de verdade.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabase-server", () => ({ createServiceClient: vi.fn() }));
vi.mock("./ml-api", () => ({
  getActiveMlConnectionForEmpresa: vi.fn(),
  getMlShipmentStatus: vi.fn(),
  getMlShipmentStatusById: vi.fn(),
}));
vi.mock("./empresa-lookup", () => ({ getEmpresaById: vi.fn() }));
vi.mock("./tiny-oauth", () => ({ getValidTokenByEmpresa: vi.fn(async () => ({ token: "tk" })) }));
vi.mock("./tiny-queue", () => ({ runWithEmpresa: (_id: string, fn: () => unknown) => fn() }));
vi.mock("./tiny-api", () => ({ listarPedidos: vi.fn() }));
vi.mock("./webhook-processor", () => ({ processWebhook: vi.fn(async () => undefined) }));
vi.mock("./webhook-processor-wms", () => ({
  promoverPedidoFutura: vi.fn(async () => ({ enfileirouLancamento: true })),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createServiceClient } from "./supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  getMlShipmentStatus,
  getMlShipmentStatusById,
} from "./ml-api";
import { getEmpresaById } from "./empresa-lookup";
import { listarPedidos } from "./tiny-api";
import { processWebhook } from "./webhook-processor";
import { promoverPedidoFutura } from "./webhook-processor-wms";
import {
  processMlNotification,
  parseShipmentIdFromResource,
  parseOrderIdFromResource,
} from "./ml-notifications";

// sb mock: 1 resultado por tabela; todo método encadeável volta o builder.
function makeSb(byTable: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from: (t: string) => {
      const result = byTable[t] ?? { data: null };
      const b: Record<string, unknown> = {};
      for (const m of [
        "select", "eq", "neq", "not", "is", "order", "limit",
        "insert", "update", "upsert",
      ]) {
        b[m] = () => b;
      }
      b.maybeSingle = async () => result;
      b.single = async () => result;
      return b;
    },
  } as unknown as ReturnType<typeof createServiceClient>;
}

const EMPRESA = {
  empresaId: "E1",
  empresaNome: "NetAir",
  galpaoId: "G1",
  galpaoNome: "CWB",
  grupoId: "GR1",
  grupoNome: "Autopecas",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parsers de resource", () => {
  it("shipment", () => {
    expect(parseShipmentIdFromResource("/shipments/47331508924")).toBe("47331508924");
    expect(parseShipmentIdFromResource("/orders/9")).toBeNull();
  });
  it("order", () => {
    expect(parseOrderIdFromResource("/orders/2000017004916482")).toBe("2000017004916482");
    expect(parseOrderIdFromResource("/shipments/9")).toBeNull();
    expect(parseOrderIdFromResource(null)).toBeNull();
  });
});

describe("intake (orders → carrega futura buffered)", () => {
  it("buffered + achado no Tiny → carrega via processWebhook", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({
        siso_pedidos: { data: null },
        siso_ml_connections: { data: { id: "conn1", empresa_id: "E1" } },
        siso_empresas: { data: { cnpj: "34857388000163" } },
        siso_webhook_logs: { data: { id: "log1" }, error: null },
      }),
    );
    vi.mocked(getMlShipmentStatus).mockResolvedValue({
      shipmentId: 999,
      status: "ready_to_ship",
      substatus: "buffered",
    });
    vi.mocked(getEmpresaById).mockResolvedValue(EMPRESA);
    vi.mocked(listarPedidos).mockResolvedValue({
      itens: [
        { id: 555, numeroPedido: 1, data: "2026-06-26", situacao: "0", ecommerce: { id: 1, nome: "ML_NET AIR", numeroPedidoEcommerce: "111" } },
      ],
    });

    const r = await processMlNotification({
      topic: "orders_v2",
      resource: "/orders/111",
      user_id: 421259712,
    });

    expect(r.reason).toBe("carregado");
    expect(r.pedidoId).toBe("555");
    expect(processWebhook).toHaveBeenCalledWith("log1", "555", "E1", "G1", "GR1", true);
  });

  it("pedido já carregado → ignora sem chamar ML", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({ siso_pedidos: { data: { id: "P0" } } }),
    );

    const r = await processMlNotification({ topic: "orders_v2", resource: "/orders/222", user_id: 1 });
    expect(r.reason).toBe("ja_carregado");
    expect(getMlShipmentStatus).not.toHaveBeenCalled();
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it("não buffered → ignora (fluxo normal cuida)", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({
        siso_pedidos: { data: null },
        siso_ml_connections: { data: { id: "conn1", empresa_id: "E1" } },
      }),
    );
    vi.mocked(getMlShipmentStatus).mockResolvedValue({
      shipmentId: 1,
      status: "ready_to_ship",
      substatus: "ready_to_print",
    });

    const r = await processMlNotification({ topic: "orders_v2", resource: "/orders/333", user_id: 1 });
    expect(r.reason).toBe("nao_buffered");
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it("buffered mas Tiny ainda não importou → adia (polling cobre)", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({
        siso_pedidos: { data: null },
        siso_ml_connections: { data: { id: "conn1", empresa_id: "E1" } },
      }),
    );
    vi.mocked(getMlShipmentStatus).mockResolvedValue({
      shipmentId: 2,
      status: "ready_to_ship",
      substatus: "buffered",
    });
    vi.mocked(getEmpresaById).mockResolvedValue(EMPRESA);
    vi.mocked(listarPedidos).mockResolvedValue({ itens: [] });

    const r = await processMlNotification({ topic: "orders_v2", resource: "/orders/444", user_id: 1 });
    expect(r.reason).toBe("tiny_nao_importou");
    expect(processWebhook).not.toHaveBeenCalled();
  });
});

describe("promoção (shipments → etiqueta liberou)", () => {
  it("ready_to_print → promove a futura", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({
        siso_pedidos: {
          data: { id: "P1", decisao_final: "propria", empresa_origem_id: "E1", separacao_galpao_id: "G1" },
        },
        siso_galpoes: { data: { nome: "CWB" } },
      }),
    );
    vi.mocked(getActiveMlConnectionForEmpresa).mockResolvedValue("conn1");
    vi.mocked(getMlShipmentStatusById).mockResolvedValue({ status: "ready_to_ship", substatus: "ready_to_print" });

    const r = await processMlNotification({ topic: "shipments", resource: "/shipments/999" });
    expect(r).toEqual({ handled: true, reason: "promovido", pedidoId: "P1" });
    expect(promoverPedidoFutura).toHaveBeenCalledWith(expect.anything(), {
      pedidoId: "P1",
      decisaoFinal: "propria",
      galpaoNome: "CWB",
      empresaId: "E1",
    });
  });

  it("ainda buffered → mantém", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeSb({
        siso_pedidos: {
          data: { id: "P2", decisao_final: "propria", empresa_origem_id: "E1", separacao_galpao_id: "G1" },
        },
        siso_galpoes: { data: { nome: "CWB" } },
      }),
    );
    vi.mocked(getActiveMlConnectionForEmpresa).mockResolvedValue("conn1");
    vi.mocked(getMlShipmentStatusById).mockResolvedValue({ status: "ready_to_ship", substatus: "buffered" });

    const r = await processMlNotification({ topic: "shipments", resource: "/shipments/888" });
    expect(r).toEqual({ handled: true, reason: "mantido", pedidoId: "P2" });
    expect(promoverPedidoFutura).not.toHaveBeenCalled();
  });

  it("sem futura viva nossa → pedido_nao_encontrado", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeSb({ siso_pedidos: { data: null } }));
    const r = await processMlNotification({ topic: "shipments", resource: "/shipments/777" });
    expect(r.reason).toBe("pedido_nao_encontrado");
  });
});

describe("roteamento", () => {
  it("tópico desconhecido → ignored_topic sem tocar no banco", async () => {
    const r = await processMlNotification({ topic: "messages", resource: "/messages/1" });
    expect(r).toEqual({ handled: false, reason: "ignored_topic" });
    expect(createServiceClient).not.toHaveBeenCalled();
  });
});
