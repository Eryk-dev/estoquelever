import { describe, it, expect, vi, beforeEach } from "vitest";

// BUG-09 (2026-06-23): /parcial deve ser idempotente por idempotency_key. Um
// reenvio do MESMO request (timeout+retry / entrega dupla de rede) passava o
// guard de re-entrada no ramo residual (loc_zerou=false, item aberto) e emitia
// 2ª S + inflava quantidade_pega. Fix: guard no topo (mesma key) retorna
// 'ja_processado' SEM reexecutar; a S/ajuste carrega a key (dedup no ledger).
// Este teste cobre o WIRING do route: guard curto-circuita antes da RPC, e key
// malformada é rejeitada (400). A lógica idempotente da RPC em si é validada ao
// vivo (S única no replay) — ver docs/relatorio-fixes-separacao-estoque.md.

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Op", galpaoId: "g1" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() },
}));

// Fake supabase: o guard chama from('siso_movimentacoes').select().eq().maybeSingle().
// jaMovExiste controla se a key "já produziu mov". rpcSpy detecta se a RPC foi
// chamada (NÃO deve ser, quando o guard curto-circuita).
let jaMovExiste = false;
const rpcSpy = vi.fn(async () => ({ data: null, error: null }));

function fakeClient() {
  return {
    from() {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "update", "delete"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = async () => ({
        data: jaMovExiste ? { id: "mov-existente" } : null,
        error: null,
      });
      chain.single = async () => ({ data: null, error: null });
      return chain;
    },
    rpc: rpcSpy,
  };
}
vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => fakeClient(),
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

const KEY = "11111111-1111-4111-8111-111111111111";

function makeReq(body: unknown): NextRequest {
  return new Request("http://x/api/wms/separacao/parcial", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": "s1" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  jaMovExiste = false;
  rpcSpy.mockClear();
});

describe("BUG-09 — guard de idempotência do /parcial", () => {
  it("modo item: key já consumida → ja_processado, sem chamar a RPC", async () => {
    jaMovExiste = true;
    const res = await POST(
      makeReq({
        pedido_item_ids: [1],
        quantidade_pega: 4,
        loc_zerou: false,
        idempotency_key: KEY,
      }),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ status: "ja_processado", idempotente: true });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("modo realocação: key já consumida → ja_processado, sem chamar a RPC", async () => {
    jaMovExiste = true;
    const res = await POST(
      makeReq({
        realocacao_ids: ["r1"],
        quantidade_pega: 2,
        loc_zerou: true,
        idempotency_key: KEY,
      }),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ status: "ja_processado", idempotente: true });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("idempotency_key malformada → 400 (não é uuid)", async () => {
    const res = await POST(
      makeReq({
        pedido_item_ids: [1],
        quantidade_pega: 4,
        loc_zerou: false,
        idempotency_key: "nao-eh-uuid",
      }),
    );
    expect(res.status).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});
