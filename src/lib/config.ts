/**
 * System configuration helpers.
 *
 * Reads/writes from siso_configuracoes table (key-value store).
 * Falls back to process.env for backwards compatibility.
 */

import { createServiceClient } from "@/lib/supabase-server";

const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get a config value by key.
 * Priority: DB → process.env (uppercase, dots replaced by underscores) → null
 */
export async function getConfig(chave: string): Promise<string | null> {
  // Check in-memory cache first
  const cached = cache.get(chave);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_configuracoes")
    .select("valor")
    .eq("chave", chave)
    .single();

  if (data?.valor) {
    cache.set(chave, { value: data.valor, expiresAt: Date.now() + CACHE_TTL_MS });
    return data.valor;
  }

  // Fallback to env var (e.g., "printnode_api_key" → "PRINTNODE_API_KEY")
  const envKey = chave.toUpperCase();
  const envVal = process.env[envKey];
  return envVal ?? null;
}

/**
 * Set a config value. Creates or updates.
 */
export async function setConfig(chave: string, valor: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from("siso_configuracoes")
    .upsert(
      { chave, valor, atualizado_em: new Date().toISOString() },
      { onConflict: "chave" },
    );

  // Update cache
  cache.set(chave, { value: valor, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Delete a config value.
 */
export async function deleteConfig(chave: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from("siso_configuracoes")
    .delete()
    .eq("chave", chave);

  cache.delete(chave);
}
