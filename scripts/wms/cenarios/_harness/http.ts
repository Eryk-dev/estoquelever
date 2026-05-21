import type { HttpClient } from "./types";

export class HttpError extends Error {
  constructor(public method: string, public path: string, public status: number, public body: unknown) {
    super(`${method} ${path} → HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export function createHttp(opts: { baseUrl: string; sessionId: string; correlationId: string }): HttpClient {
  async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const url = `${opts.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-Session-Id": opts.sessionId,
      "X-Correlation-Id": opts.correlationId,
      ...(extraHeaders ?? {}),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }

    if (!res.ok) throw new HttpError(method, path, res.status, parsed);
    return parsed as T;
  }

  return {
    get: (p, headers) => request("GET", p, undefined, headers),
    post: (p, b, headers) => request("POST", p, b, headers),
    patch: (p, b, headers) => request("PATCH", p, b, headers),
    delete: (p, headers) => request("DELETE", p, undefined, headers),
  };
}
