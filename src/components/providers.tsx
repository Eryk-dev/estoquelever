"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth-context";
import { ServiceWorkerRegister } from "@/components/sw-register";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            // Cold starts cross-region (us-east fn ↔ us-west DB) make the v5
            // default retry:3 (≈1+2+4s backoff) feel like a multi-second hang.
            retry: 1,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
            // Operational lists are kept fresh by realtime + per-query polling;
            // refiring every query on tab-focus just re-pays the auth tax.
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {children}
        <Toaster position="bottom-center" duration={2200} />
        <ServiceWorkerRegister />
      </AuthProvider>
    </QueryClientProvider>
  );
}
