import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ id: "u1", nome: "Comprador" }) }));
vi.mock("@/lib/permissions", () => ({ userCan: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => makeSb(sbConfig) }));

let sbConfig: {
  pedido: Record<string, unknown> | null;
  itens?: unknown[];
  onUpdatePedido?: (v: Record<string, unknown>) => void;
};

function makeSb(config: typeof sbConfig) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      not: () => chain,
      update: (v: Record<string, unknown>) => {
        (chain as { _update?: Record<string, unknown> })._update = v;
        return chain;
      },
      maybeSingle: async () =>
        table === "siso_pedidos"
          ? { data: config.pedido, error: null }
          : { data: null, error: null },
      then: (resolve: (r: unknown) => void) => {
        const upd = (chain as { _update?: Record<string, unknown> })._update;
        if (upd && table === "siso_pedidos") {
          config.onUpdatePedido?.(upd);
          return resolve({ error: null });
        }
        if (table === "siso_pedido_itens") return resolve({ data: config.itens ?? [], error: null });
        return resolve({ data: null, error: null });
      },
    });
    return chain;
  };
  return { from };
}

import { POST } from "./route";

function makeReq(body: unknown) {
  return new Request("http://x/api/wms/compras/redestinar", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/wms/compras/redestinar", () => {
  it("status redestinável (aguardando_compra) → re-aponta separacao_galpao_id", async () => {
    let captured: Record<string, unknown> | null = null;
    sbConfig = {
      pedido: { status_separacao: "aguardando_compra", separacao_galpao_id: "g-old", empresa_origem_id: "e1" },
      itens: [],
      onUpdatePedido: (v) => (captured = v),
    };
    const res = await POST(makeReq({ pedido_ids: ["p1"], galpao_id: "g-new" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redestinados).toEqual(["p1"]);
    expect(json.pulados).toEqual([]);
    expect(captured).toEqual({ separacao_galpao_id: "g-new" });
  });

  it("status NÃO redestinável (separado) → pulado, não re-aponta", async () => {
    let captured: Record<string, unknown> | null = null;
    sbConfig = {
      pedido: { status_separacao: "separado", separacao_galpao_id: "g-old", empresa_origem_id: "e1" },
      itens: [],
      onUpdatePedido: (v) => (captured = v),
    };
    const res = await POST(makeReq({ pedido_ids: ["p1"], galpao_id: "g-new" }));
    const json = await res.json();
    expect(json.redestinados).toEqual([]);
    expect(json.pulados[0].id).toBe("p1");
    expect(json.pulados[0].motivo).toMatch(/separado/);
    expect(captured).toBeNull();
  });

  it("já no galpão destino → pulado (no-op)", async () => {
    sbConfig = {
      pedido: { status_separacao: "validacao_oc", separacao_galpao_id: "g-new", empresa_origem_id: "e1" },
      itens: [],
    };
    const res = await POST(makeReq({ pedido_ids: ["p1"], galpao_id: "g-new" }));
    const json = await res.json();
    expect(json.redestinados).toEqual([]);
    expect(json.pulados[0].motivo).toMatch(/galpão/);
  });

  it("body inválido → 400", async () => {
    sbConfig = { pedido: null };
    const res = await POST(makeReq({ pedido_ids: [], galpao_id: "" }));
    expect(res.status).toBe(400);
  });
});
