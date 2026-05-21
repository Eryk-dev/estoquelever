// src/lib/wms/dashboard-tarefas.ts
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recebe lista possivelmente com nulls/undefined e duplicatas; retorna
 * apenas IDs únicos, em ordem de primeira aparição.
 */
export function dedupNonNullIds(
  ids: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type Executor = {
  id: string;
  nome: string;
  foto_url: string | null;
};

/**
 * Hidrata uma lista de IDs com os dados do usuário, ignorando IDs que
 * não estão no map (usuário deletado ou inacessível). Preserva a ordem
 * de entrada.
 */
export function hidratarExecutores(
  ids: string[],
  usuarios: Map<string, Executor>,
): Executor[] {
  const out: Executor[] = [];
  for (const id of ids) {
    const u = usuarios.get(id);
    if (u) out.push(u);
  }
  return out;
}

export type DashboardTarefasResult = {
  galpao_id: string | null;
  aprovacao: { count: number };
  separacao: { count: number; executores: Executor[] };
  embalagem: { count: number; executores: Executor[] };
  guarda: { count: number; executores: Executor[] };
  compras: { aComprar: number; aReceber: number };
  inventario: { sessoesAtivas: number; executores: Executor[] };
};

/**
 * Monta o payload do quadro de tarefas pendentes da home /wms.
 *
 * Quando `galpao_id` é null, agrega de todos os galpões (modo "Todos").
 * Quando é um uuid, filtra por `separacao_galpao_id` (em pedidos),
 * `galpao_id` (em guarda/inventário). Compras é sempre global.
 */
export async function montarDashboardTarefas(
  _sb: SupabaseClient,
  galpao_id: string | null,
): Promise<DashboardTarefasResult> {
  return {
    galpao_id,
    aprovacao: { count: 0 },
    separacao: { count: 0, executores: [] },
    embalagem: { count: 0, executores: [] },
    guarda: { count: 0, executores: [] },
    compras: { aComprar: 0, aReceber: 0 },
    inventario: { sessoesAtivas: 0, executores: [] },
  };
}
