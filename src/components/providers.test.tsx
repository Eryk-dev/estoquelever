import { useQuery, focusManager } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "./providers";

vi.mock("@/lib/auth-context", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/sw-register", () => ({
  ServiceWorkerRegister: () => null,
}));
vi.mock("@/components/client-error-reporter", () => ({
  ClientErrorReporter: () => null,
}));
vi.mock("sonner", () => ({ Toaster: () => null }));

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
});

describe("Providers — retomada de aba longa", () => {
  it("refaz query ativa e vencida quando a aba recupera foco", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queryFn = vi.fn().mockResolvedValue("ok");

    function Probe() {
      useQuery({
        queryKey: ["long-session-focus-recovery"],
        queryFn,
      });
      return null;
    }

    focusManager.setFocused(true);
    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    focusManager.setFocused(false);
    now += 31_000;
    focusManager.setFocused(true);

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });
});
