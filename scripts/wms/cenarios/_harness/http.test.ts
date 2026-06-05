import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttp, HttpError, NetworkError } from "./http";

afterEach(() => vi.restoreAllMocks());

function http() {
  return createHttp({ baseUrl: "http://x", sessionId: "s", correlationId: "c" });
}

describe("http retry", () => {
  it("retenta em throw de rede e sucede na 2ª tentativa", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await http().get<{ ok: boolean }>("/x");
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lança NetworkError após esgotar retries de rede", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(http().get("/x")).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("NÃO retenta num 400 de negócio — lança HttpError na hora", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(http().post("/x", {})).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retenta em 503 e sucede quando estabiliza", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await http().get<{ ok: number }>("/x");
    expect(r.ok).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
