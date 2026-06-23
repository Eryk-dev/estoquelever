/**
 * Client-side error reporter.
 *
 * Sends operator-facing errors (render crashes, uncaught JS, API 5xx) to
 * POST /api/wms/client-error, which forwards them to Discord. Plain fetch (not
 * sisoFetch) so a failed report can't trigger the 401-redirect side effect.
 *
 * Never throws. A light client-side throttle prevents a tight error loop (e.g.
 * a component re-throwing on every render) from hammering the endpoint — the
 * server still dedups for the Discord channel.
 */

const STORAGE_KEY = "siso_user"; // mirrors auth-context.tsx
const THROTTLE_MS = 5_000;
const recent = new Map<string, number>();

export interface ClientErrorInput {
  message: string;
  /** Stack trace or response body. */
  stack?: string | null;
  /** e.g. 'frontend:boundary', 'frontend:window', 'frontend:promise', 'frontend:api'. */
  source: string;
  /** Page URL the operator is on. */
  url?: string | null;
  requestPath?: string | null;
  requestMethod?: string | null;
  status?: number | null;
  metadata?: Record<string, unknown>;
}

function getSessionId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sessionId?: string } | null;
    return parsed?.sessionId ?? null;
  } catch {
    return null;
  }
}

/** Report a client error. Fire-and-forget, never throws. */
export function reportClientError(input: ClientErrorInput): void {
  try {
    if (typeof window === "undefined") return;

    const key = `${input.source}|${input.message}`.slice(0, 300);
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last < THROTTLE_MS) return;
    recent.set(key, now);
    if (recent.size > 200) recent.clear();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const sessionId = getSessionId();
    if (sessionId) headers["X-Session-Id"] = sessionId;

    void fetch("/api/wms/client-error", {
      method: "POST",
      headers,
      // keepalive lets the report survive a page unload (e.g. a hard crash).
      keepalive: true,
      body: JSON.stringify({
        message: String(input.message).slice(0, 1000),
        stack: input.stack ? String(input.stack).slice(0, 4000) : null,
        source: input.source,
        url: input.url ?? window.location.href,
        requestPath: input.requestPath ?? null,
        requestMethod: input.requestMethod ?? null,
        status: input.status ?? null,
        metadata: input.metadata ?? null,
      }),
    }).catch(() => {
      // swallow — reporting an error must never produce another
    });
  } catch {
    // swallow
  }
}

/** Report a 5xx response from a sisoFetch call. Reads a cloned response. */
export async function reportApiServerError(
  url: string | URL | Request,
  init: RequestInit | undefined,
  clonedResponse: Response,
): Promise<void> {
  try {
    const path =
      typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body = "";
    try {
      body = (await clonedResponse.text()).slice(0, 2000);
    } catch {
      // ignore body read failure
    }
    reportClientError({
      source: "frontend:api",
      message: `API ${clonedResponse.status} ${method} ${path}`,
      stack: body || null,
      status: clonedResponse.status,
      requestPath: path,
      requestMethod: method,
    });
  } catch {
    // swallow
  }
}
