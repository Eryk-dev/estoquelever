/**
 * Resolves grupo membership for multi-empresa display flows.
 *
 * Fase 5 (ledger 3D): grupo deixou de ser eixo de roteamento/dedução de
 * estoque. Em 3D, estoque é fungível por (produto, galpão, localização) —
 * não há mais "ordem de dedução por tier de grupo" nem "agregação cross-
 * empresa dentro do grupo". O roteamento vive em `wms/roteamento.ts` e usa
 * preferências geográficas da empresa vendedora, não filiação de grupo.
 *
 * Este módulo agora serve apenas pra LOOKUP DE MEMBROS de grupo, usado por:
 *  - Admin pages (CRUD de grupos)
 *  - Display em compras/cross para listar empresas afins
 *  - Tiny legacy path (webhook-processor.ts / execution-worker.ts) pra
 *    escolher empresa-deposito de saída no Tiny (até Plano 6 deprecar essa
 *    rota).
 *
 * Caches mantém TTL 5min.
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
 *
 * Continua usado por:
 *  - Admin pages (/wms/configuracoes — CRUD de grupos)
 *  - APIs admin/grupos/* (lookup de membros)
 *  - Display em compras/cross/pedidos (filtros visuais)
 *  - Tiny legacy path (escolha de empresa-suporte pra saída no Tiny)
 *
 * NÃO use isso pra decisão de roteamento/dedução do ledger — esse caminho
 * saiu da Fase 5 (3D). Roteamento vive em `wms/roteamento.ts`.
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
        siso_galpoes!siso_empresas_galpao_id_fkey!inner ( id, nome )
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
 * Lookup do grupo que uma empresa pertence (ou null se não pertence).
 * Função "afinidade" — usada pra display em compras/cross.
 */
export async function getGrupoByEmpresa(
  empresaId: string,
): Promise<{ grupoId: string; tier: number } | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_grupo_empresas")
    .select("grupo_id, tier")
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (!data) return null;
  return { grupoId: data.grupo_id, tier: data.tier };
}

/**
 * Get active empresas of a grupo within a specific galpao.
 * Pure display helper — não usar pra dedução de estoque.
 */
export async function getEmpresasPorGalpao(
  grupoId: string,
  galpaoId: string,
): Promise<EmpresaGrupo[]> {
  const todas = await getEmpresasDoGrupo(grupoId);
  return todas.filter((e) => e.galpaoId === galpaoId);
}

/** Clear cache */
export function clearGrupoCache(): void {
  cache.clear();
}
