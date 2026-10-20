import { mlFetch } from "./ml-api";
import { isMlDisabled } from "./ml-stub";
import type { MlReconciliationEvidence, MlTrackingEvent } from "./ml-reconciliation-policy";

type Id = string | number;
interface Order {
  id: Id;
  seller?: { id?: Id };
  status?: string;
  pack_id?: Id | null;
  shipping?: { id?: Id | null };
  tags?: string[];
}
interface Shipment {
  id: Id;
  sender_id?: Id;
  status?: string;
  substatus?: string | null;
}
const validId = (id: unknown): id is Id =>
  (typeof id === "string" || typeof id === "number") && /^\d+$/.test(String(id));

/** No fallback on auth/rate-limit/errors: absence of evidence is never "not sent". */
export async function getMlReconciliationEvidence(params: {
  connectionId: string;
  sellerId: string;
  orderId: string | null;
  shipmentId: string | null;
}): Promise<MlReconciliationEvidence> {
  if (isMlDisabled()) throw new Error("Integração Mercado Livre desabilitada");
  const { connectionId, sellerId } = params;
  const deadline = AbortSignal.timeout(50_000);
  const read = <T>(path: string, history = false) =>
    mlFetch<T>(connectionId, path, {
      cache: "no-store",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      headers: history ? { "x-format-new": "true" } : undefined,
    });
  let shipmentId = params.shipmentId;
  if (!shipmentId) {
    if (!validId(params.orderId)) throw new Error("Pedido ML sem identificador válido");
    const orderId = params.orderId;
    let order: Order;
    try {
      order = await read<Order>(`/orders/${orderId}`);
      if (String(order.id) !== orderId) throw new Error("Pedido ML divergente");
    } catch (error) {
      // Um pack dá 404 em /orders. Qualquer outro erro deve ser repetido depois.
      if (!(error instanceof Error) || !error.message.startsWith(`ML API 404 /orders/${orderId}:`)) {
        throw error;
      }
      const pack = await read<{ id: Id; orders?: { id: Id }[]; shipment?: { id?: Id } }>(
        `/packs/${orderId}`,
      );
      const childId = pack.orders?.[0]?.id;
      if (String(pack.id) !== orderId || !validId(childId)) throw new Error("Pack ML inválido");
      order = await read<Order>(`/orders/${childId}`);
      if (String(order.id) !== String(childId) || String(order.pack_id) !== orderId ||
          !validId(pack.shipment?.id) ||
          String(order.shipping?.id) !== String(pack.shipment.id)) {
        throw new Error("Vínculo pedido/pack/envio ML divergente");
      }
    }
    if (String(order.seller?.id) !== sellerId || !order.status) {
      throw new Error("Pedido ML pertence a outra conta ou tem resposta incompleta");
    }
    if (order.status === "cancelled" || order.status === "canceled") {
      return {
        kind: "order", resourceId: String(order.id), orderReference: params.orderId, connectionId, sellerId,
        checkedAt: new Date().toISOString(), status: order.status, substatus: null,
        noShipping: false, history: [],
      };
    }
    if (!order.shipping || !Object.hasOwn(order.shipping, "id")) {
      throw new Error("Resposta ML sem informação de envio");
    }
    if (order.shipping.id === null && order.tags?.includes("no_shipping")) {
      return {
        kind: "order", resourceId: String(order.id), orderReference: params.orderId, connectionId, sellerId,
        checkedAt: new Date().toISOString(), status: order.status, substatus: null,
        noShipping: true, history: [],
      };
    }
    if (!validId(order.shipping.id)) throw new Error("Envio ML não resolvido");
    shipmentId = String(order.shipping.id);
  }
  if (!validId(shipmentId)) throw new Error("Envio ML inválido");
  const shipment = await read<Shipment>(`/shipments/${shipmentId}`);
  if (String(shipment.id) !== shipmentId || String(shipment.sender_id) !== sellerId || !shipment.status) {
    throw new Error("Envio ML pertence a outra conta ou tem resposta incompleta");
  }
  const history = await read<MlTrackingEvent[]>(`/shipments/${shipmentId}/history`, true);
  if (!Array.isArray(history) || !history.every(event =>
    event && typeof event.status === "string" && typeof event.date === "string" &&
    Number.isFinite(Date.parse(event.date)) &&
    (event.substatus === null || typeof event.substatus === "string"))) {
    throw new Error("Histórico ML inválido; nenhuma etapa será alterada");
  }
  return {
    kind: "shipment", resourceId: shipmentId, orderReference: params.orderId, connectionId, sellerId,
    checkedAt: new Date().toISOString(), status: shipment.status,
    substatus: shipment.substatus ?? null, noShipping: false, history,
  };
}
