/**
 * recuperarEtiquetaViaMl — puxa a etiqueta ZPL direto do Mercado Livre quando o
 * pedido ML não tem rota Tiny (sem NF nem agrupamento). Cacheia etiqueta_zpl +
 * barcodes + status 'pendente'. No-op pra pedido não-ML, sem order id, sem
 * conexão ML, ou já cacheado.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getActiveMlConnectionForEmpresa = vi.fn();
const obterEtiquetaZplShipment = vi.fn();
vi.mock("@/lib/ml-api", () => ({
  getActiveMlConnectionForEmpresa: (...a: unknown[]) =>
    getActiveMlConnectionForEmpresa(...a),
  obterEtiquetaZplShipment: (...a: unknown[]) => obterEtiquetaZplShipment(...a),
}));
vi.mock("@/lib/etiqueta-barcode", () => ({
  montarBarcodesEtiqueta: () => ["BR123"],
}));
vi.mock("@/lib/etiqueta-barcode-raster", () => ({
  extrairBarcodesDoRaster: async () => [],
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Supabase client mock: captura update payloads e a linha do pedido.
let pedidoRow: Record<string, unknown> | null;
const updatePayloads: Array<Record<string, unknown>> = [];
const rpcCalls: Array<{ fn: string; args: unknown }> = [];

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: pedidoRow }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        updatePayloads.push(payload);
        return { eq: async () => ({ error: null }) };
      },
    }),
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ error: null });
    },
  }),
}));

import { recuperarEtiquetaViaMl } from "@/lib/etiqueta-ml";

beforeEach(() => {
  pedidoRow = null;
  updatePayloads.length = 0;
  rpcCalls.length = 0;
  getActiveMlConnectionForEmpresa.mockReset();
  obterEtiquetaZplShipment.mockReset();
});

describe("recuperarEtiquetaViaMl", () => {
  it("pedido ML sem ZPL → baixa do ML, cacheia ZPL + barcodes + status pendente", async () => {
    pedidoRow = {
      id_pedido_ecommerce: "2000017128461680",
      nome_ecommerce: "EASY MERCADO LIVRE",
      empresa_origem_id: "emp-1",
      etiqueta_zpl: null,
    };
    getActiveMlConnectionForEmpresa.mockResolvedValue("conn-1");
    obterEtiquetaZplShipment.mockResolvedValue({
      zpl: "^XA...^XZ",
      shipmentId: 47390200318,
      trackingNumber: "BR123",
    });

    const zpl = await recuperarEtiquetaViaMl("938500863");

    expect(zpl).toBe("^XA...^XZ");
    expect(obterEtiquetaZplShipment).toHaveBeenCalledWith("conn-1", "2000017128461680");
    expect(updatePayloads[0]).toMatchObject({
      etiqueta_zpl: "^XA...^XZ",
      etiqueta_barcodes: ["BR123"],
    });
    expect(rpcCalls[0]).toEqual({
      fn: "siso_set_etiqueta_status",
      args: { p_pedido_id: "938500863", p_status: "pendente" },
    });
  });

  it("já tem ZPL cacheado → devolve o cacheado sem tocar o ML", async () => {
    pedidoRow = {
      id_pedido_ecommerce: "X",
      nome_ecommerce: "EASY MERCADO LIVRE",
      empresa_origem_id: "emp-1",
      etiqueta_zpl: "^XA cacheado ^XZ",
    };

    const zpl = await recuperarEtiquetaViaMl("p1");

    expect(zpl).toBe("^XA cacheado ^XZ");
    expect(getActiveMlConnectionForEmpresa).not.toHaveBeenCalled();
    expect(obterEtiquetaZplShipment).not.toHaveBeenCalled();
    expect(updatePayloads).toHaveLength(0);
  });

  it("pedido não-ML (Shopee) → null, sem tocar o ML", async () => {
    pedidoRow = {
      id_pedido_ecommerce: "260629CYXUBEAT",
      nome_ecommerce: "Shopee",
      empresa_origem_id: "emp-1",
      etiqueta_zpl: null,
    };

    const zpl = await recuperarEtiquetaViaMl("p2");

    expect(zpl).toBeNull();
    expect(getActiveMlConnectionForEmpresa).not.toHaveBeenCalled();
    expect(obterEtiquetaZplShipment).not.toHaveBeenCalled();
  });

  it("empresa sem conexão ML ativa → null", async () => {
    pedidoRow = {
      id_pedido_ecommerce: "2000017128461680",
      nome_ecommerce: "EASY MERCADO LIVRE",
      empresa_origem_id: "emp-1",
      etiqueta_zpl: null,
    };
    getActiveMlConnectionForEmpresa.mockResolvedValue(null);

    const zpl = await recuperarEtiquetaViaMl("p3");

    expect(zpl).toBeNull();
    expect(obterEtiquetaZplShipment).not.toHaveBeenCalled();
  });

  it("ML não devolve ZPL imprimível (ex.: buffered) → null, sem cachear", async () => {
    pedidoRow = {
      id_pedido_ecommerce: "2000017128461680",
      nome_ecommerce: "EASY MERCADO LIVRE",
      empresa_origem_id: "emp-1",
      etiqueta_zpl: null,
    };
    getActiveMlConnectionForEmpresa.mockResolvedValue("conn-1");
    obterEtiquetaZplShipment.mockResolvedValue(null);

    const zpl = await recuperarEtiquetaViaMl("p4");

    expect(zpl).toBeNull();
    expect(updatePayloads).toHaveLength(0);
  });
});
