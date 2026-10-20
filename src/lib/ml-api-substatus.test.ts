/**
 * Fase 0 — Separação Futura: classificador de substatus do shipment ML.
 *
 * getMlShipmentStatus resolve o shipmentId (order→shipping.id / pack→shipment.id,
 * mesma lógica do getMlShipmentSla) e busca GET /shipments/{id} pra ler
 * `substatus` — o sinal autoritativo de "futuro (buffered) vs agora
 * (ready_to_print)". O /sla NÃO carrega substatus, por isso é fetch próprio.
 *
 * Fixtures = os 2 pedidos reais da prova de campo (NetAir, 2026-06-24):
 *   - 2000017088119608 (Condensador) → ready_to_print
 *   - 2000017087998330 (Botão)       → buffered
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ml-oauth", () => ({
  ML_API_BASE: "https://api.mercadolibre.com",
  getValidMlToken: vi.fn(async () => "fake-token"),
}));
vi.mock("./ml-stub", () => ({
  isMlDisabled: () => false,
  getMlUserMeStub: vi.fn(),
  searchSellerItemsBySkuStub: vi.fn(),
  searchAndMatchItemsBySkuStub: vi.fn(),
  getMlItemsDetailsStub: vi.fn(),
  testarMlConnectionStub: vi.fn(),
}));
vi.mock("./supabase-server", () => ({ createServiceClient: vi.fn() }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getMlShipmentStatus, getMlShipmentRecuperacao } from "./ml-api";

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("getMlShipmentRecuperacao", () => {
  it("mantém remetente, logística e histórico para a validação de despacho", async () => {
    const shipment = {
      id: 333, sender_id: 421259712, status: "ready_to_ship", substatus: "printed",
      logistic_type: "cross_docking", status_history: { date_shipped: null },
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/PACK1")) return jsonRes({}, 404);
      if (url.endsWith("/packs/PACK1")) return jsonRes({ shipment: { id: 333 } });
      if (url.endsWith("/shipments/333")) return jsonRes(shipment);
      throw new Error(`unexpected url ${url}`);
    });
    expect(await getMlShipmentRecuperacao("conn", "PACK1")).toEqual(shipment);
  });
  it("erro ao ler envio impede que o chamador importe às cegas", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/X")) return jsonRes({ shipping: { id: 333 } });
      return jsonRes({ error: "rate_limit" }, 429);
    });
    await expect(getMlShipmentRecuperacao("conn", "X")).rejects.toThrow("429");
  });
});

describe("getMlShipmentStatus", () => {
  it("Condensador 2000017088119608 → substatus ready_to_print", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/2000017088119608"))
        return jsonRes({ shipping: { id: 111 } });
      if (url.endsWith("/shipments/111"))
        return jsonRes({ status: "ready_to_ship", substatus: "ready_to_print" });
      throw new Error(`unexpected url ${url}`);
    });

    const r = await getMlShipmentStatus("conn-1", "2000017088119608");
    expect(r).toEqual({
      shipmentId: 111,
      status: "ready_to_ship",
      substatus: "ready_to_print",
    });
  });

  it("Botão 2000017087998330 → substatus buffered", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/2000017087998330"))
        return jsonRes({ shipping: { id: 222 } });
      if (url.endsWith("/shipments/222"))
        return jsonRes({ status: "ready_to_ship", substatus: "buffered" });
      throw new Error(`unexpected url ${url}`);
    });

    const r = await getMlShipmentStatus("conn-1", "2000017087998330");
    expect(r?.substatus).toBe("buffered");
    expect(r?.shipmentId).toBe(222);
  });

  it("resolve via /packs quando /orders dá 404 (carrinho)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/PACK1")) return jsonRes({ error: "not found" }, 404);
      if (url.endsWith("/packs/PACK1"))
        return jsonRes({ shipment: { id: 333 } });
      if (url.endsWith("/shipments/333"))
        return jsonRes({ status: "ready_to_ship", substatus: "buffered" });
      throw new Error(`unexpected url ${url}`);
    });

    const r = await getMlShipmentStatus("conn-1", "PACK1");
    expect(r).toEqual({
      shipmentId: 333,
      status: "ready_to_ship",
      substatus: "buffered",
    });
  });

  it("shipment sem substatus → substatus null", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/X")) return jsonRes({ shipping: { id: 444 } });
      if (url.endsWith("/shipments/444")) return jsonRes({ status: "pending" });
      throw new Error(`unexpected url ${url}`);
    });

    const r = await getMlShipmentStatus("conn-1", "X");
    expect(r).toEqual({ shipmentId: 444, status: "pending", substatus: null });
  });

  it("sem shipment (order sem shipping nem pack) → null", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/NOSHIP")) return jsonRes({ shipping: null });
      throw new Error(`unexpected url ${url}`);
    });

    const r = await getMlShipmentStatus("conn-1", "NOSHIP");
    expect(r).toBeNull();
  });
});
