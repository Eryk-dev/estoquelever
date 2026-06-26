/**
 * obterEtiquetaZplShipment — baixa a etiqueta ZPL direto do Mercado Livre quando
 * a NF já foi expedida no Tiny (o agrupamento Tiny nunca conterá a NF).
 *
 * Resolve o shipmentId (order→shipping.id / pack→shipment.id, igual ao
 * getMlShipmentStatus), lê o tracking (best-effort) e baixa
 * GET /shipment_labels?...&response_type=zpl2 — que retorna um ZIP no MESMO
 * layout do Tiny ("Etiqueta de envio.txt" = ZPL + "Controle.pdf"), descompactado
 * pelo extrator compartilhado.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import JSZip from "jszip";

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

import { obterEtiquetaZplShipment } from "./ml-api";

const ZPL = "^XA\n^FO20,20^BCN,80,Y,N,N\n^FD123456^FS\n^XZ";
let zipBuffer: ArrayBuffer;

beforeAll(async () => {
  const zip = new JSZip();
  zip.file("Etiqueta de envio.txt", ZPL);
  zip.file("Controle.pdf", "%PDF-1.6 fake");
  zipBuffer = await zip.generateAsync({ type: "arraybuffer" });
});

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function zipRes(buf: ArrayBuffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/zip"]]),
    arrayBuffer: async () => buf,
    text: async () => "",
  } as unknown as Response;
}

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("obterEtiquetaZplShipment", () => {
  it("pedido ML → resolve shipment, baixa ZIP do ML e extrai o ZPL", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/2000017004916482"))
        return jsonRes({ shipping: { id: 47331508924 } });
      if (url.endsWith("/shipments/47331508924"))
        return jsonRes({ tracking_number: "MEL47331508924FMXDF01" });
      if (url.includes("/shipment_labels?shipment_ids=47331508924"))
        return zipRes(zipBuffer);
      throw new Error(`unexpected url ${url}`);
    });

    const r = await obterEtiquetaZplShipment("conn-1", "2000017004916482");

    expect(r).not.toBeNull();
    expect(r!.shipmentId).toBe(47331508924);
    expect(r!.trackingNumber).toBe("MEL47331508924FMXDF01");
    expect(r!.zpl.startsWith("^XA")).toBe(true);
    expect(r!.zpl).toContain("^BCN");
    // o label foi pedido em zpl2
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("response_type=zpl2"),
      ),
    ).toBe(true);
  });

  it("resolve via /packs quando /orders dá 404 (carrinho)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/PACK1")) return jsonRes({}, 404);
      if (url.endsWith("/packs/PACK1"))
        return jsonRes({ shipment: { id: 555 } });
      if (url.endsWith("/shipments/555"))
        return jsonRes({ tracking_number: null });
      if (url.includes("/shipment_labels?shipment_ids=555"))
        return zipRes(zipBuffer);
      throw new Error(`unexpected url ${url}`);
    });

    const r = await obterEtiquetaZplShipment("conn-1", "PACK1");
    expect(r!.shipmentId).toBe(555);
    expect(r!.trackingNumber).toBeNull();
    expect(r!.zpl.startsWith("^XA")).toBe(true);
  });

  it("sem shipment (order sem shipping e pack 404) → null, sem baixar etiqueta", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/X")) return jsonRes({ shipping: null });
      throw new Error(`unexpected url ${url}`);
    });

    const r = await obterEtiquetaZplShipment("conn-1", "X");
    expect(r).toBeNull();
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/shipment_labels")),
    ).toBe(false);
  });

  it("download da etiqueta falha (404) → null", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/2000017004916482"))
        return jsonRes({ shipping: { id: 999 } });
      if (url.endsWith("/shipments/999"))
        return jsonRes({ tracking_number: "T" });
      if (url.includes("/shipment_labels?shipment_ids=999"))
        return zipRes(new ArrayBuffer(0), 404);
      throw new Error(`unexpected url ${url}`);
    });

    const r = await obterEtiquetaZplShipment("conn-1", "2000017004916482");
    expect(r).toBeNull();
  });
});
