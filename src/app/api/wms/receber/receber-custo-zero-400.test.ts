import { describe, it, expect, vi } from "vitest";

// requireWarehouseAccess sempre ok; receberEstoque NÃO deve nem ser chamado (rejeitamos antes).
// (a rota usa requireWarehouseAccess, não requireAuth — verificado em receber/route.ts:26).
vi.mock("@/lib/wms/auth", () => ({
  requireWarehouseAccess: async () => ({ ok: true, user: { id: "u1" } }),
  requireAuth: async () => ({ ok: true, user: { id: "u1" } }),
}));
// vi.mock é hoisted acima das declarações top-level — o spy precisa viver em
// vi.hoisted pra estar inicializado quando a factory roda.
const { receberSpy } = vi.hoisted(() => ({
  receberSpy: vi.fn(async () => ({ pendencia_ids: [], lote_id: "l1", mov_ids: [] })),
}));
vi.mock("@/lib/wms/movimentacoes", () => ({ receberEstoque: receberSpy }));
// stubs leves pra o import do route não puxar deps pesadas de putaway/supabase.
vi.mock("@/lib/wms/putaway", () => ({
  sugerirLocalizacaoPutaway: vi.fn(),
  listarLocaisExistentesProduto: vi.fn(),
}));
vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => ({}) }));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://x/api/wms/receber", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/wms/receber — custo 0 com qty>0", () => {
  it("rejeita custo_unitario=0 com 400 (não deixa chegar na RPC e virar 5xx)", async () => {
    const res = await POST(
      makeReq({
        galpao_id: "g1",
        origem_tipo: "nf_compra",
        empresa_compradora_id: "e1",
        fornecedor_id: "f1",
        itens: [{ produto_id: "p1", qty: 5, custo_unitario: 0 }],
      }) as never,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(String(json.error)).toMatch(/custo/i);
    expect(receberSpy).not.toHaveBeenCalled();
  });
});
