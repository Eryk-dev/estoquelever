import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./ml-api", () => ({ mlFetch: mocks.fetch }));
vi.mock("./ml-stub", () => ({ isMlDisabled: () => false }));
import { getMlReconciliationEvidence as read } from "./ml-reconciliation-api";
const params = { connectionId: "conn", sellerId: "30", orderId: "10", shipmentId: "20" };
const shipment = { id: 20, sender_id: 30, status: "ready_to_ship", substatus: "in_packing_list" };
const history = [{ date: "2026-10-20T13:00:00Z", status: "ready_to_ship", substatus: "picked_up" }];
beforeEach(() => { mocks.fetch.mockReset(); });

describe("leitura autoritativa ML", () => {
  it("valida remetente e exige histórico com x-format-new", async () => {
    mocks.fetch.mockResolvedValueOnce(shipment).mockResolvedValueOnce(history);
    expect(await read(params)).toMatchObject({ resourceId: "20", sellerId: "30", history });
    expect(mocks.fetch.mock.calls[1][2]).toMatchObject({ headers: { "x-format-new": "true" }, cache: "no-store" });
  });
  it("não confunde outro seller com a conta consultada", async () => {
    mocks.fetch.mockResolvedValue({ ...shipment, sender_id: 99 });
    await expect(read(params)).rejects.toThrow("outra conta");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("objeto de shipment devolvido como histórico não é aceito", async () => {
    mocks.fetch.mockResolvedValue(shipment);
    await expect(read(params)).rejects.toThrow("Histórico ML inválido");
  });
  it("no_shipping só vale com tag e shipping.id explicitamente nulo", async () => {
    mocks.fetch.mockResolvedValue({ id: 10, seller: { id: 30 }, status: "paid", shipping: { id: null }, tags: ["no_shipping"] });
    expect(await read({ ...params, shipmentId: null })).toMatchObject({ noShipping: true, kind: "order" });
    mocks.fetch.mockResolvedValue({ id: 10, seller: { id: 30 }, status: "paid", tags: ["no_shipping"] });
    await expect(read({ ...params, shipmentId: null })).rejects.toThrow("sem informação de envio");
  });
  it.each([401, 429, 500])("erro %i não vira ausência de rastreio nem fallback pack", async status => {
    mocks.fetch.mockRejectedValue(new Error(`ML API ${status} /orders/10: error`));
    await expect(read({ ...params, shipmentId: null })).rejects.toThrow(String(status));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("resolve pack por um pedido filho, validando seller e vínculo", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("ML API 404 /orders/10: not found"))
      .mockResolvedValueOnce({ id: 10, shipment: { id: 20 }, orders: [{ id: 11 }] })
      .mockResolvedValueOnce({ id: 11, pack_id: 10, seller: { id: 30 }, status: "paid", shipping: { id: 20 } })
      .mockResolvedValueOnce(shipment).mockResolvedValueOnce(history);
    expect(await read({ ...params, shipmentId: null })).toMatchObject({ kind: "shipment", resourceId: "20" });
  });
  it("não aceita pack de outra conta", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("ML API 404 /orders/10: not found"))
      .mockResolvedValueOnce({ id: 10, shipment: { id: 20 }, orders: [{ id: 11 }] })
      .mockResolvedValueOnce({ id: 11, pack_id: 10, seller: { id: 99 }, status: "paid", shipping: { id: 20 } });
    await expect(read({ ...params, shipmentId: null })).rejects.toThrow("outra conta");
  });
});
