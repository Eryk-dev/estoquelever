import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reconcile: vi.fn(), after: vi.fn() }));
vi.mock("@/lib/ml-reconciliation", () => ({ reconcileMlOrders: mocks.reconcile }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("next/server", async importOriginal => ({
  ...await importOriginal<typeof import("next/server")>(), after: mocks.after,
}));
import { GET } from "./route";
beforeEach(() => {
  vi.stubEnv("WORKER_SECRET", "test-worker");
  mocks.reconcile.mockReset().mockResolvedValue({ companies: [] });
  mocks.after.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("cron de conferência ML", () => {
  it("não aceita acesso público nem segredo em query string", async () => {
    expect((await GET(new Request("https://example.test?secret=test-worker"))).status).toBe(401);
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it("responde antes da varredura para não bloquear pg_net", async () => {
    const response = await GET(new Request("https://example.test", { headers: { "x-worker-secret": "test-worker" } }));
    expect(response.status).toBe(202);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });
  it("permite validação síncrona sem alterar etapas, somente com o segredo", async () => {
    const response = await GET(new Request("https://example.test?wait=1&dry_run=1&limit=2", { headers: { "x-worker-secret": "test-worker" } }));
    expect(response.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, limitPerLane: 2 }));
  });
});
