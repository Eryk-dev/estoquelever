import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("./tiny-stub", () => ({ isTinyDisabled: () => false }));

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  logError: vi.fn(),
};
vi.mock("./logger", () => ({ logger: loggerMock }));

// Estado da conexão por teste. `selectRows` é consumido em ordem por cada
// .select(...).single(): a 1ª leitura é o getValidToken; a 2ª (quando há) é o
// re-read de recuperação dentro do refreshAndSave.
const state = {
  selectRows: [] as Array<Record<string, unknown> | null>,
  selectCount: 0,
  updates: [] as Array<{ payload: Record<string, unknown> }>,
};

function makeQuery() {
  const ctx: { op: "select" | "update"; payload: Record<string, unknown> | null } = {
    op: "select",
    payload: null,
  };
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.update = (payload: Record<string, unknown>) => {
    ctx.op = "update";
    ctx.payload = payload;
    return q;
  };
  q.eq = () => {
    if (ctx.op === "update") {
      state.updates.push({ payload: ctx.payload! });
      return Promise.resolve({ data: null, error: null });
    }
    return q;
  };
  q.single = () => {
    const row = state.selectRows[state.selectCount] ?? null;
    state.selectCount += 1;
    return Promise.resolve({ data: row, error: null });
  };
  return q;
}

vi.mock("./supabase-server", () => ({
  createServiceClient: () => ({ from: () => makeQuery() }),
}));

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

const baseConn = {
  id: "conn-1",
  access_token: "OLD-TOKEN",
  refresh_token: "OLD-REFRESH",
  token_expires_at: PAST, // expirado → força refresh
  client_id: "cid",
  client_secret: "csec",
};

function fetchFail400() {
  return {
    ok: false,
    status: 400,
    text: async () =>
      '{"error":"invalid_grant","error_description":"Token is not active"}',
  };
}

function fetchOk(token: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: token,
      refresh_token: "NEW-REFRESH",
      expires_in: 21600,
      token_type: "Bearer",
    }),
  };
}

let getValidToken: typeof import("./tiny-oauth").getValidToken;

beforeEach(async () => {
  vi.resetModules();
  state.selectRows = [];
  state.selectCount = 0;
  state.updates = [];
  loggerMock.info.mockClear();
  loggerMock.logError.mockClear();
  // re-importa pra zerar o Map de inflightRefresh entre testes
  ({ getValidToken } = await import("./tiny-oauth"));
});

describe("getValidToken — corrida de refresh (Keycloak rotation)", () => {
  it("recupera silenciosamente quando refresh perde a corrida (token fresco no re-read)", async () => {
    state.selectRows = [
      baseConn, // 1ª leitura: expirado
      { access_token: "WINNER-TOKEN", token_expires_at: FUTURE }, // re-read: já renovado
    ];
    global.fetch = vi.fn().mockResolvedValue(fetchFail400()) as unknown as typeof fetch;

    const token = await getValidToken("conn-1");

    expect(token).toBe("WINNER-TOKEN");
    expect(loggerMock.logError).not.toHaveBeenCalled(); // sem alarme falso
    // não deve marcar erro nem sobrescrever token
    expect(state.updates).toHaveLength(0);
  });

  it("loga critical e marca erro quando refresh_token está genuinamente morto", async () => {
    state.selectRows = [
      baseConn,
      { access_token: "OLD-TOKEN", token_expires_at: PAST }, // re-read: nada mudou
    ];
    global.fetch = vi.fn().mockResolvedValue(fetchFail400()) as unknown as typeof fetch;

    await expect(getValidToken("conn-1")).rejects.toThrow(/Token refresh failed/);

    expect(loggerMock.logError).toHaveBeenCalledTimes(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].payload.token_status).toBe("erro");
  });

  it("deduplica refreshes concorrentes da mesma conexão (uma única chamada ao Tiny)", async () => {
    state.selectRows = [baseConn, baseConn]; // ambas as leituras: expirado
    const fetchMock = vi.fn().mockResolvedValue(fetchOk("FRESH-TOKEN"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      getValidToken("conn-1"),
      getValidToken("conn-1"),
    ]);

    expect(a).toBe("FRESH-TOKEN");
    expect(b).toBe("FRESH-TOKEN");
    expect(fetchMock).toHaveBeenCalledTimes(1); // refresh disparado uma vez só
  });
});
