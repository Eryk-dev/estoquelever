import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processar: vi.fn(),
  session: vi.fn(),
}));

vi.mock("@/lib/ml-anuncios-index", () => ({
  processarFatiaIndiceMl: mocks.processar,
}));
vi.mock("@/lib/session", () => ({
  getSessionUser: mocks.session,
}));

import { GET } from "./route";

const previousWorkerSecret = process.env.WORKER_SECRET;

beforeEach(() => {
  process.env.WORKER_SECRET = "worker-test";
  mocks.processar.mockReset();
  mocks.session.mockReset();
  mocks.processar.mockResolvedValue({
    contas_ativas: 1,
    processadas: 1,
    concluidas: 0,
    erros: 0,
    resultados: [],
  });
});

afterEach(() => {
  process.env.WORKER_SECRET = previousWorkerSecret;
});

describe("GET /api/wms/ml/anuncios-indexar", () => {
  it("aceita o cron somente pelo header secreto e processa uma fatia", async () => {
    const response = await GET(
      new Request("http://localhost/api/wms/ml/anuncios-indexar", {
        headers: { "X-Worker-Secret": "worker-test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.processar).toHaveBeenCalledOnce();
  });

  it("não aceita segredo pela URL e exige sessão", async () => {
    mocks.session.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/wms/ml/anuncios-indexar?secret=worker-test",
      ),
    );

    expect(response.status).toBe(401);
    expect(mocks.processar).not.toHaveBeenCalled();
  });
});
