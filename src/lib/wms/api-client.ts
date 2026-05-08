import { sisoFetch } from "@/lib/auth-context";

/**
 * Wrapper sobre sisoFetch que valida a resposta e devolve JSON tipado.
 *
 * Sem isso, useQuery tipava `{ rows }` mas em 4xx/5xx recebia `{ error }`,
 * fazendo `data?.rows.map(...)` crashar no client. Aqui a chamada lança em
 * caso de !r.ok, então useQuery aciona isError e a UI renderiza o estado
 * de erro em vez de quebrar.
 */
export async function wmsApi<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await sisoFetch(path, init);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      // body não era JSON; mantém HTTP code
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}
