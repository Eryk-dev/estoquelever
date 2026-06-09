import { describe, it, expect, vi } from "vitest";

// Token Tiny morto (invalid_grant) NÃO deve travar o pick do operador.
// localizacao/route.ts faz 2 coisas: (1) sync da loc pro Tiny [cosmético],
// (2) movs WMS [fonte da verdade]. (1) falhando não pode 500 a rota inteira.
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Op" }),
}));

const { atualizarSpy } = vi.hoisted(() => ({ atualizarSpy: vi.fn() }));
vi.mock("@/lib/tiny-oauth", () => ({
  getValidTokenByEmpresa: async () => {
    throw new Error(
      'Token refresh failed (400): {"error":"invalid_grant","error_description":"Token is not active"}',
    );
  },
}));
vi.mock("@/lib/tiny-api", () => ({ atualizarLocalizacaoProduto: atualizarSpy }));
vi.mock("@/lib/tiny-queue", () => ({
  runWithEmpresa: async (_e: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/wms/ledger", () => ({ inserirMovimentacao: vi.fn() }));
vi.mock("@/lib/wms/reservas", () => ({
  reservarAtomico: vi.fn(),
  estornarReservaIndividual: vi.fn(),
}));
vi.mock("@/lib/separacao/wms-mapping", () => ({ resolverLocalizacaoWms: vi.fn() }));

// supabase: resolução de galpão retorna null → pula o bloco de movs WMS.
// (foco do teste: a falha do Tiny não derruba a rota.)
vi.mock("@/lib/supabase-server", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "gt", "limit", "in"]) {
    chain[m] = () => chain;
  }
  chain.maybeSingle = async () => ({ data: null });
  chain.single = async () => ({ data: null });
  return { createServiceClient: () => chain };
});

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/separacao/localizacao", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/wms/separacao/localizacao — Tiny desacoplado", () => {
  it("token Tiny morto NÃO trava a rota: retorna ok + tiny_sync=false", async () => {
    const res = await POST(
      makeReq({
        produto_id: 12345,
        localizacao: "A-01-2",
        empresa_id: "e1",
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.tiny_sync).toBe(false);
  });
});
