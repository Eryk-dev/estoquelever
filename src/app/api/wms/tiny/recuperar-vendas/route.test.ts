import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), nf: vi.fn() }));
vi.mock("@/lib/wms/auth", () => ({ requireAdmin: m.auth }));
vi.mock("@/lib/supabase-server", () => ({ createServiceClient: () => ({ from: m.from }) }));
vi.mock("@/lib/nf-webhook-handler", () => ({ handleNfWebhook: m.nf }));
import { GET, POST } from "./route";
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ ok: true, user: { id: "admin" } });
});
it("recusa leitura e execução sem autorização administrativa", async () => {
  m.auth.mockResolvedValue({ ok: false, response: new Response("unauthorized", { status: 401 }) });
  expect((await GET(new Request("https://wms.test/api"))).status).toBe(401);
  expect((await POST(new Request("https://wms.test/api", { method: "POST" }))).status).toBe(401);
  expect(m.from).not.toHaveBeenCalled();
  expect(m.nf).not.toHaveBeenCalled();
});
it("recusa empresa inválida, lote excessivo e JSON inválido antes de acessar dados", async () => {
  expect((await GET(new Request("https://wms.test/api?empresaId=invalida"))).status).toBe(400);
  for (const body of [
    "{",
    JSON.stringify({ empresaId: "11111111-1111-4111-8111-111111111111", notas: [1, 2, 3, 4, 5, 6] }),
    JSON.stringify({ empresaId: "11111111-1111-4111-8111-111111111111", notas: [Number.MAX_SAFE_INTEGER + 1] }),
  ]) {
    expect((await POST(new Request("https://wms.test/api", { method: "POST", body }))).status).toBe(400);
  }
  expect(m.from).not.toHaveBeenCalled();
  expect(m.nf).not.toHaveBeenCalled();
});
