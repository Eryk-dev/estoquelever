/**
 * Resolves grupo membership and deduction order for multi-empresa stock logic.
 *
 * Caches grupo data with 5min TTL.
 */

import { createServiceClient } from "./supabase-server";

export interface EmpresaGrupo {
  empresaId: string;
  empresaNome: string;
  galpaoId: string;
  galpaoNome: string;
  tier: number;
}

interface CacheEntry {
  data: EmpresaGrupo[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Get all active empresas in a grupo, ordered by tier then name.
 */
export async function getEmpresasDoGrupo(
  grupoId: string,
): Promise<EmpresaGrupo[]> {
  const cached = cache.get(grupoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const supabase = createServiceClient();

  const { data: rows } = await supabase
    .from("siso_grupo_empresas")
    .select(`
      tier,
      empresa_id,
      siso_empresas!inner (
        id, nome, ativo,
        siso_galpoes!inner ( id, nome )
      )
    `)
    .eq("grupo_id", grupoId)
    .eq("siso_empresas.ativo", true);

  if (!rows?.length) return [];

  const empresas: EmpresaGrupo[] = rows.map((row) => {
    const emp = row.siso_empresas as unknown as {
      id: string;
      nome: string;
      siso_galpoes: { id: string; nome: string };
    };
    return {
      empresaId: emp.id,
      empresaNome: emp.nome,
      galpaoId: emp.siso_galpoes.id,
      galpaoNome: emp.siso_galpoes.nome,
      tier: row.tier,
    };
  });

  // Sort by tier (asc), then name (asc) for deterministic ordering
  empresas.sort((a, b) => a.tier - b.tier || a.empresaNome.localeCompare(b.empresaNome));

  cache.set(grupoId, { data: empresas, expiresAt: Date.now() + CACHE_TTL_MS });
  return empresas;
}

/**
 * Get active empresas of a grupo within a specific galpao.
 */
export async function getEmpresasPorGalpao(
  grupoId: string,
  galpaoId: string,
): Promise<EmpresaGrupo[]> {
  const todas = await getEmpresasDoGrupo(grupoId);
  return todas.filter((e) => e.galpaoId === galpaoId);
}

/**
 * Get ordered list of empresas for stock deduction.
 *
 * Order:
 * 1. The empresa that received the order (always first, tier 1 override)
 * 2. Other empresas in the same galpao, by tier
 * 3. Empresas in other galpoes, by tier
 */
export async function getOrdemDeducao(
  grupoId: string,
  empresaOrigemId: string,
): Promise<EmpresaGrupo[]> {
  const todas = await getEmpresasDoGrupo(grupoId);

  const origem = todas.find((e) => e.empresaId === empresaOrigemId);
  if (!origem) return todas;

  const galpaoOrigemId = origem.galpaoId;

  // Split into: origin empresa, same galpao (others), other galpoes
  const mesmoGalpao = todas.filter(
    (e) => e.galpaoId === galpaoOrigemId && e.empresaId !== empresaOrigemId,
  );
  const outrosGalpoes = todas.filter(
    (e) => e.galpaoId !== galpaoOrigemId,
  );

  return [origem, ...mesmoGalpao, ...outrosGalpoes];
}

/**
 * Aggregate stock data by galpao from per-empresa data.
 */
export function agregarEstoquePorGalpao(
  estoques: Array<{
    empresaId: string;
    galpaoId: string;
    galpaoNome: string;
    disponivel: number;
    saldo: number;
    reservado: number;
    depositoId: number | null;
    depositoNome: string | null;
  }>,
): Map<
  string,
  {
    galpaoId: string;
    galpaoNome: string;
    disponivel: number;
    saldo: number;
    reservado: number;
  }
> {
  const porGalpao = new Map<
    string,
    {
      galpaoId: string;
      galpaoNome: string;
      disponivel: number;
      saldo: number;
      reservado: number;
    }
  >();

  for (const est of estoques) {
    const existing = porGalpao.get(est.galpaoId);
    if (existing) {
      existing.disponivel += est.disponivel;
      existing.saldo += est.saldo;
      existing.reservado += est.reservado;
    } else {
      porGalpao.set(est.galpaoId, {
        galpaoId: est.galpaoId,
        galpaoNome: est.galpaoNome,
        disponivel: est.disponivel,
        saldo: est.saldo,
        reservado: est.reservado,
      });
    }
  }

  return porGalpao;
}

/** Clear cache */
export function clearGrupoCache(): void {
  cache.clear();
}
