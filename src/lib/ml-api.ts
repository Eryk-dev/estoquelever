/**
 * Cliente da API do Mercado Livre.
 *
 * Sempre envia o token via header Authorization: Bearer (nunca query string,
 * conforme guideline de segurança ML). Faz auto-retry 1× em 401 — pedindo
 * refresh do token e tentando de novo.
 */
import { ML_API_BASE, getValidMlToken } from "./ml-oauth";
import { logger } from "./logger";

// ─── Tipos ──────────────────────────────────────────────────────────

export interface MlUserMe {
  id: number;
  nickname: string;
  email?: string;
  site_id: string;
  user_type?: string;
}

export interface MlItemSearchResp {
  seller_id: string;
  paging: { limit: number; offset: number; total: number };
  results: string[]; // array de MLB ids
}

export interface MlItem {
  id: string;
  title: string;
  price: number;
  currency_id: string;
  status: string; // active | paused | closed | under_review | inactive | …
  permalink: string;
  available_quantity: number;
  sold_quantity?: number;
  thumbnail?: string;
  listing_type_id?: string;
  seller_custom_field?: string | null;
  attributes?: Array<{ id: string; name: string; value_name: string | null }>;
}

// ─── Fetch genérico com auto-refresh em 401 ─────────────────────────

async function mlFetch<T>(
  connectionId: string,
  path: string,
  init?: RequestInit & { retried?: boolean },
): Promise<T> {
  const token = await getValidMlToken(connectionId);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");

  const url = path.startsWith("http") ? path : `${ML_API_BASE}${path}`;
  const res = await fetch(url, { ...init, headers });

  // 401 → 1 retry (em caso de expiração no meio do voo)
  if (res.status === 401 && !init?.retried) {
    logger.info("ml-api", "401 — forçando refresh + retry", { connectionId, path });
    // força refresh setando expires_at no passado
    const { createServiceClient } = await import("./supabase-server");
    await createServiceClient()
      .from("siso_ml_connections")
      .update({ token_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", connectionId);
    return mlFetch<T>(connectionId, path, { ...init, retried: true });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ML API ${res.status} ${path}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

// ─── Endpoints usados ───────────────────────────────────────────────

export function getMlUserMe(connectionId: string): Promise<MlUserMe> {
  return mlFetch<MlUserMe>(connectionId, "/users/me");
}

/**
 * Busca anúncios por SKU usando os 2 caminhos suportados pelo ML:
 *   1. seller_custom_field (SKU livre no anúncio)
 *   2. seller_sku (atributo padronizado SELLER_SKU)
 *
 * Retorna a união (dedupe) de MLB ids encontrados.
 */
export async function searchSellerItemsBySku(
  connectionId: string,
  sellerId: number,
  sku: string,
): Promise<string[]> {
  const enc = encodeURIComponent(sku);
  const [byCustomField, bySellerSku] = await Promise.allSettled([
    mlFetch<MlItemSearchResp>(
      connectionId,
      `/users/${sellerId}/items/search?sku=${enc}&limit=50`,
    ),
    mlFetch<MlItemSearchResp>(
      connectionId,
      `/users/${sellerId}/items/search?seller_sku=${enc}&limit=50`,
    ),
  ]);

  const ids = new Set<string>();
  if (byCustomField.status === "fulfilled") {
    byCustomField.value.results.forEach((id) => ids.add(id));
  } else {
    logger.warn("ml-api", "search by sku falhou", {
      connectionId,
      sku,
      err: String(byCustomField.reason),
    });
  }
  if (bySellerSku.status === "fulfilled") {
    bySellerSku.value.results.forEach((id) => ids.add(id));
  } else {
    logger.warn("ml-api", "search by seller_sku falhou", {
      connectionId,
      sku,
      err: String(bySellerSku.reason),
    });
  }
  return Array.from(ids);
}

/**
 * Multi-get de detalhes de items (até 20 por chamada).
 * Retorna lista deduplicada com campos essenciais pro UI do recebimento.
 */
export async function getMlItemsDetails(
  connectionId: string,
  itemIds: string[],
): Promise<MlItem[]> {
  if (itemIds.length === 0) return [];

  const out: MlItem[] = [];
  // ML aceita até 20 ids por multi-get
  for (let i = 0; i < itemIds.length; i += 20) {
    const slice = itemIds.slice(i, i + 20);
    const attributes =
      "id,title,price,currency_id,status,permalink,available_quantity," +
      "sold_quantity,thumbnail,listing_type_id,seller_custom_field,attributes";
    const resp = await mlFetch<
      Array<{ code: number; body: MlItem }>
    >(
      connectionId,
      `/items?ids=${slice.join(",")}&attributes=${attributes}`,
    );
    resp.forEach((r) => {
      if (r.code === 200 && r.body) out.push(r.body);
    });
  }
  return out;
}

// ─── Test connection ────────────────────────────────────────────────

export async function testarMlConnection(
  connectionId: string,
): Promise<{ ok: boolean; nickname?: string; erro?: string }> {
  try {
    const me = await getMlUserMe(connectionId);
    return { ok: true, nickname: me.nickname };
  } catch (err) {
    return { ok: false, erro: err instanceof Error ? err.message : String(err) };
  }
}
