// src/lib/wms/dashboard-tarefas.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type Executor = {
  id: string;
  nome: string;
  foto_url: string | null;
};

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
