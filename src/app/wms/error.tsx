"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-report";

/**
 * Error boundary for all /wms operator screens. Catches React render crashes
 * (which the global window 'error' handler can't see), reports them to Discord,
 * and shows the operator a recoverable fallback.
 */
export default function WmsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError({
      source: "frontend:boundary",
      message: error.message || "Erro de renderização",
      stack: error.stack ?? null,
      metadata: error.digest ? { digest: error.digest } : undefined,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg font-semibold">Algo quebrou nesta tela</h2>
      <p className="max-w-md text-sm text-neutral-500">
        O erro foi registrado automaticamente. Tente de novo — se continuar, avise o suporte.
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
      >
        Tentar de novo
      </button>
    </div>
  );
}
