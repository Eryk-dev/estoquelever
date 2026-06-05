import { describe, it, expect, vi } from "vitest";

// requireAdmin sempre ok (não testamos auth aqui).
vi.mock("@/lib/wms/auth", () => ({
  requireAdmin: async () => ({ ok: true, user: { id: "u1" } }),
}));

// Simula: SELECT do produto_id (despromove) OK; UPDATE final retorna 23505.
vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: () => ({
      // .select("produto_id").eq("id", id).single()  → despromove pre-step
      // .update(...).eq("id", id).select().single()  → update final (23505)
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { produto_id: "prod-1" }, error: null }),
        }),
      }),
      update: () => ({
        eq: () => ({
          // a 1ª update (despromove) NÃO tem .select() encadeado → resolve direto;
          // a 2ª (update final) tem .select().single() → 23505.
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: "23505", message: "duplicate key idx_pf_preferencial" },
            }),
          }),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        }),
      }),
    }),
  };
  return { createServiceClient: () => client };
});

import type { NextRequest } from "next/server";
import { PATCH } from "./[id]/route";

function makeReq(body: unknown): NextRequest {
  return new Request("http://x/api/wms/produto-fornecedores/pf-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

describe("PATCH produto-fornecedores — 23505 vira 409", () => {
  it("responde 409 quando o update bate no unique idx_pf_preferencial", async () => {
    const res = await PATCH(makeReq({ preferencial: true }), {
      params: Promise.resolve({ id: "pf-1" }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(String(json.error)).toMatch(/preferencial/i);
  });
});
