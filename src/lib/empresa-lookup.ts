/**
 * Replaces cnpj-filial.ts — looks up empresa by CNPJ from siso_empresas.
 *
 * Caches results in-memory with 5min TTL to avoid DB queries on every webhook.
 */

import { createServiceClient } from "./supabase-server";

export interface EmpresaInfo {
  empresaId: string;
  empresaNome: string;
  galpaoId: string;
  galpaoNome: string;
  grupoId: string | null;
  grupoNome: string | null;
}

interface CacheEntry {
  data: EmpresaInfo;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

function cleanCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "");
}

/**
 * Look up empresa by CNPJ. Returns null if not found or inactive.
 */
export async function getEmpresaByCnpj(
  cnpj: string,
): Promise<EmpresaInfo | null> {
  const clean = cleanCnpj(cnpj);

  // Check cache
  const cached = cache.get(clean);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const supabase = createServiceClient();

  const { data: empresa } = await supabase
    .from("siso_empresas")
    .select(`
      id,
      nome,
      galpao_id,
      siso_galpoes!inner ( id, nome ),
      siso_grupo_empresas ( grupo_id, siso_grupos ( id, nome ) )
    `)
    .eq("cnpj", clean)
    .eq("ativo", true)
    .single();

  if (!empresa) return null;

  const galpao = empresa.siso_galpoes as unknown as { id: string; nome: string };
  const grupoRel = (empresa.siso_grupo_empresas as unknown as Array<{
    grupo_id: string;
    siso_grupos: { id: string; nome: string };
  }>)?.[0];

  const grupoId = grupoRel?.siso_grupos?.id ?? null;

  // Log if empresa has no grupo (helps debug missing grupo relationships)
  if (!grupoId) {
    console.warn(`[empresa-lookup] ${empresa.nome} (${clean}) has no grupo. siso_grupo_empresas result:`, JSON.stringify(empresa.siso_grupo_empresas));
  }

  const info: EmpresaInfo = {
    empresaId: empresa.id,
    empresaNome: empresa.nome,
    galpaoId: galpao.id,
    galpaoNome: galpao.nome,
    grupoId,
    grupoNome: grupoRel?.siso_grupos?.nome ?? null,
  };

  cache.set(clean, { data: info, expiresAt: Date.now() + CACHE_TTL_MS });
  return info;
}

/**
 * Look up empresa by ID. Returns null if not found.
 */
export async function getEmpresaById(
  empresaId: string,
): Promise<EmpresaInfo | null> {
  // Check cache by iterating (empresa_id is not the key)
  for (const entry of cache.values()) {
    if (entry.data.empresaId === empresaId && entry.expiresAt > Date.now()) {
      return entry.data;
    }
  }

  const supabase = createServiceClient();

  const { data: empresa } = await supabase
    .from("siso_empresas")
    .select(`
      id,
      nome,
      cnpj,
      galpao_id,
      siso_galpoes!inner ( id, nome ),
      siso_grupo_empresas ( grupo_id, siso_grupos ( id, nome ) )
    `)
    .eq("id", empresaId)
    .single();

  if (!empresa) return null;

  const galpao = empresa.siso_galpoes as unknown as { id: string; nome: string };
  const grupoRel = (empresa.siso_grupo_empresas as unknown as Array<{
    grupo_id: string;
    siso_grupos: { id: string; nome: string };
  }>)?.[0];

  const info: EmpresaInfo = {
    empresaId: empresa.id,
    empresaNome: empresa.nome,
    galpaoId: galpao.id,
    galpaoNome: galpao.nome,
    grupoId: grupoRel?.siso_grupos?.id ?? null,
    grupoNome: grupoRel?.siso_grupos?.nome ?? null,
  };

  cache.set(cleanCnpj(empresa.cnpj), {
    data: info,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return info;
}

/** Clear cache (useful for tests or after config changes) */
export function clearEmpresaCache(): void {
  cache.clear();
}
