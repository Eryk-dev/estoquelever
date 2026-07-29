import { beforeEach, describe, expect, it, vi } from "vitest";

const realtime = {
  connect: vi.fn(),
  onHeartbeat: vi.fn(),
};
const createClient = vi.fn(() => ({ realtime }));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("Supabase Realtime de longa duração", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
  });

  it("mantém heartbeat em worker e reconecta quando a conexão cai", async () => {
    await import("./supabase");

    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-test",
      expect.objectContaining({
        realtime: expect.objectContaining({ worker: true }),
      }),
    );

    const heartbeat = realtime.onHeartbeat.mock.calls[0]?.[0];
    expect(heartbeat).toBeTypeOf("function");

    heartbeat("disconnected");
    expect(realtime.connect).toHaveBeenCalledOnce();
  });
});
