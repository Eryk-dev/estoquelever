"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-report";

/**
 * Mounts global handlers for uncaught JS errors and unhandled promise
 * rejections, forwarding them to /api/wms/client-error. Renders nothing.
 *
 * React render crashes are NOT caught here (they're swallowed by React) —
 * those are reported by the error.tsx / global-error.tsx boundaries.
 */
export function ClientErrorReporter() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      // Skip empty/cross-origin "Script error." with no detail — pure noise.
      if (!event.error && !event.message) return;
      reportClientError({
        source: "frontend:window",
        message: event.message || "Uncaught error",
        stack: event.error instanceof Error ? (event.error.stack ?? null) : null,
        metadata: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    }

    function onRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "Unhandled promise rejection";
      reportClientError({
        source: "frontend:promise",
        message,
        stack: reason instanceof Error ? (reason.stack ?? null) : null,
      });
    }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
