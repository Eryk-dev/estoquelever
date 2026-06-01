import type { HttpClient } from "./types";

export class HttpError extends Error {
  constructor(public method: string, public path: string, public status: number, public body: unknown) {
    super(`${method} ${path} → HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    this.name = "HttpError";
  }
}

// Erro de rede/infra (servidor caiu, ECONNRESET) — distinto de um 4xx/5xx de
// negócio. Usado pra classificar a falha como "infra-fail" e nunca mascarar bug
// de estoque como se fosse instabilidade.
export class NetworkError extends Error {
  constructor(public method: string, public path: string, public causa: unknown) {
    super(`${method} ${path} → erro de rede após retries: ${causa instanceof Error ? causa.message : String(causa)}`);
    this.name = "NetworkError";
  }
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_TENTATIVAS = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

    let ultimoErroRede: unknown = null;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // throw de rede (fetch failed / ECONNRESET / ECONNREFUSED) → retry com backoff
        ultimoErroRede = e;
        if (tentativa < MAX_TENTATIVAS) {
          await sleep(250 * 2 ** (tentativa - 1));
          continue;
        }
        throw new NetworkError(method, path, e);
      }

      // 502/503/504 = servidor instável → retry. Outros 4xx/5xx = erro de
      // negócio (o sinal que estamos testando) → NÃO retry.
      if (RETRYABLE_STATUS.has(res.status) && tentativa < MAX_TENTATIVAS) {
        await sleep(250 * 2 ** (tentativa - 1));
        continue;
      }

      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }

      if (!res.ok) throw new HttpError(method, path, res.status, parsed);
      return parsed as T;
    }
    throw new NetworkError(method, path, ultimoErroRede);
  }

  return {
    get: (p, headers) => request("GET", p, undefined, headers),
    post: (p, b, headers) => request("POST", p, b, headers),
    patch: (p, b, headers) => request("PATCH", p, b, headers),
    delete: (p, headers) => request("DELETE", p, undefined, headers),
  };
}
