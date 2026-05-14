/**
 * Agregador de anúncios por SKU em todas as conexões ML ativas.
 *
 * Estratégia:
 *   1. Lê todas as siso_ml_connections ativas
 *   2. Pra cada conexão, busca MLB ids por seller_custom_field + seller_sku
 *   3. Multi-GET nos items pra trazer (title, price, status, permalink, …)
 *   4. Persiste no cache (siso_ml_anuncios_cache)
 *   5. Devolve lista flat agrupada por conta
 *
 * Cache TTL: 5 minutos. Se o cache de uma conexão estiver fresco, evita
 * chamar a API ML novamente.
 */
import { createServiceClient } from "./supabase-server";
import { searchAndMatchItemsBySku, type MlItem } from "./ml-api";
import { logger } from "./logger";

export interface AnuncioMl {
  conexao_id: string;
  conta_nickname: string;
  mlb_id: string;
  title: string;
  price: number | null;
  status: string | null;
  permalink: string | null;
  available_quantity: number | null;
  sold_quantity: number | null;
  thumbnail: string | null;
  listing_type_id: string | null;
}

const CACHE_TTL_MS = 5 * 60_000; // 5 minutos

interface Conn {
  id: string;
  ml_user_id: number;
  nickname: string;
}

async function listActiveConnections(): Promise<Conn[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_ml_connections")
    .select("id, ml_user_id, nickname")
    .eq("ativo", true)
    .not("access_token", "is", null);
  return data ?? [];
}

async function readCacheForConn(
  conexaoId: string,
  sku: string,
): Promise<AnuncioMl[] | null> {
  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const { data } = await supabase
    .from("siso_ml_anuncios_cache")
    .select(
      "mlb_id, title, price, status, permalink, available_quantity, sold_quantity, thumbnail, listing_type_id, atualizado_em",
    )
    .eq("conexao_id", conexaoId)
    .eq("sku", sku)
    .gte("atualizado_em", cutoff);
  if (!data || data.length === 0) return null;

  // sentinela: precisamos do nickname; quem chama compõe
  return data.map((r) => ({
    conexao_id: conexaoId,
    conta_nickname: "",
    mlb_id: r.mlb_id,
    title: r.title,
    price: r.price,
    status: r.status,
    permalink: r.permalink,
    available_quantity: r.available_quantity,
    sold_quantity: r.sold_quantity,
    thumbnail: r.thumbnail,
    listing_type_id: r.listing_type_id,
  }));
}

async function persistCache(
  conexaoId: string,
  sku: string,
  items: MlItem[],
): Promise<void> {
  const supabase = createServiceClient();

  // Apaga cache antigo dessa (conexao, sku) — evita anúncios antigos
  // que o seller já tirou do SKU ficarem mostrando pra sempre.
  await supabase
    .from("siso_ml_anuncios_cache")
    .delete()
    .eq("conexao_id", conexaoId)
    .eq("sku", sku);

  if (items.length === 0) return;

  const rows = items.map((it) => ({
    conexao_id: conexaoId,
    sku,
    mlb_id: it.id,
    title: it.title,
    price: it.price ?? null,
    status: it.status ?? null,
    permalink: it.permalink ?? null,
    available_quantity: it.available_quantity ?? null,
    sold_quantity: it.sold_quantity ?? null,
    thumbnail: it.thumbnail ?? null,
    listing_type_id: it.listing_type_id ?? null,
    raw: it as unknown as Record<string, unknown>,
    atualizado_em: new Date().toISOString(),
  }));

  await supabase.from("siso_ml_anuncios_cache").upsert(rows, {
    onConflict: "conexao_id,mlb_id",
  });
}

/**
 * Busca anúncios pro SKU em todas as conexões. Usa cache (TTL 5min) por
 * conexão+sku. Não falha em conexões individuais — se uma der erro,
 * retorna anúncios das outras + log.
 */
export async function getAnunciosPorSku(
  sku: string,
  opts?: { conexaoIds?: string[]; forceRefresh?: boolean },
): Promise<{
  anuncios: AnuncioMl[];
  contas_consultadas: number;
  contas_com_erro: Array<{ conexao_id: string; nickname: string; erro: string }>;
}> {
  const skuNorm = sku.trim();
  if (!skuNorm) {
    return { anuncios: [], contas_consultadas: 0, contas_com_erro: [] };
  }

  let conns = await listActiveConnections();
  if (opts?.conexaoIds && opts.conexaoIds.length > 0) {
    const ids = new Set(opts.conexaoIds);
    conns = conns.filter((c) => ids.has(c.id));
  }

  const erros: Array<{ conexao_id: string; nickname: string; erro: string }> =
    [];

  const results = await Promise.all(
    conns.map(async (c) => {
      try {
        if (!opts?.forceRefresh) {
          const cached = await readCacheForConn(c.id, skuNorm);
          if (cached) {
            return cached.map((a) => ({ ...a, conta_nickname: c.nickname }));
          }
        }
        const items = await searchAndMatchItemsBySku(
          c.id,
          c.ml_user_id,
          skuNorm,
        );
        await persistCache(c.id, skuNorm, items);
        return items.map<AnuncioMl>((it) => ({
          conexao_id: c.id,
          conta_nickname: c.nickname,
          mlb_id: it.id,
          title: it.title,
          price: it.price ?? null,
          status: it.status ?? null,
          permalink: it.permalink ?? null,
          available_quantity: it.available_quantity ?? null,
          sold_quantity: it.sold_quantity ?? null,
          thumbnail: it.thumbnail ?? null,
          listing_type_id: it.listing_type_id ?? null,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("ml-anuncios", "Falha pra conexão", {
          conexao_id: c.id,
          nickname: c.nickname,
          erro: msg,
        });
        erros.push({ conexao_id: c.id, nickname: c.nickname, erro: msg });
        return [] as AnuncioMl[];
      }
    }),
  );

  const flat = results.flat().sort((a, b) => {
    // ativos primeiro, depois pausados, depois fechados
    const ord = (s: string | null) =>
      s === "active" ? 0 : s === "paused" ? 1 : 2;
    const diff = ord(a.status) - ord(b.status);
    if (diff !== 0) return diff;
    return a.conta_nickname.localeCompare(b.conta_nickname);
  });

  return {
    anuncios: flat,
    contas_consultadas: conns.length,
    contas_com_erro: erros,
  };
}
