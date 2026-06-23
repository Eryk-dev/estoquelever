"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-report";

/**
 * Backstop boundary for crashes in the root layout itself (where wms/error.tsx
 * can't help). Must render its own <html>/<body>. Uses inline styles because
 * the app's CSS may not have loaded if the root failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError({
      source: "frontend:global",
      message: error.message || "Erro fatal",
      stack: error.stack ?? null,
      metadata: error.digest ? { digest: error.digest } : undefined,
    });
  }, [error]);

  return (
    <html lang="pt-BR">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
          textAlign: "center",
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>Algo quebrou</h2>
        <p style={{ fontSize: 14, color: "#666", maxWidth: 420 }}>
          O erro foi registrado automaticamente. Recarregue a página.
        </p>
        <button
          onClick={reset}
          style={{
            borderRadius: 6,
            background: "#171717",
            color: "#fff",
            border: "none",
            padding: "8px 16px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Tentar de novo
        </button>
      </body>
    </html>
  );
}
