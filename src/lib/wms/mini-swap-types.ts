/**
 * Mini-swap intra-galpão — tipos compartilhados entre algoritmo, orchestrator e RPC.
 *
 * Spec: docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md
 */

/** Saldo de uma empresa em uma loc específica de um galpão pra um SKU. */
export interface SaldoLinha {
  empresa_dona_id: string;
  localizacao_id: string;
  localizacao_codigo: string;
  saldo: number;
  reservado: number;
}

/** Snapshot de estoque do galpão pra um SKU específico. */
export interface EstadoEstoqueSku {
  produto_id: string;
  galpao_id: string;
  linhas: SaldoLinha[];
}

/** Demanda de picking de uma wave: empresa picadora precisa de qty_total do SKU. */
export interface Demanda {
  empresa_picadora_id: string;
  produto_id: string;
  qty_total: number;
  /**
   * Qty que outras empresas vão emprestar pra cobrir esse pedido (decisão do roteamento).
   * Mini-swap NÃO pode exceder esse valor na parte de empréstimo.
   */
  qty_emprestimo_planejada: number;
  /** IDs das reservas existentes (movs origem='reserva_pedido') que precisam ser canceladas/recriadas. */
  reservas_existentes_ids: string[];
}

/** Uma operação de swap par S+E entre 2 empresas em 1 loc. */
export interface OperacaoSwap {
  loc_id: string;
  empresa_origem_id: string; // perde qty
  empresa_destino_id: string; // ganha qty
  qty: number;
}

/** Operação de empréstimo (re-cria reserva na nova loc consolidada). */
export interface OperacaoEmprestimo {
  loc_id: string;
  empresa_credora_id: string;
  empresa_devedora_id: string;
  qty: number;
}

/** Plano executado pra uma demanda específica. */
export interface PlanoDemanda {
  produto_id: string;
  empresa_picadora_id: string;
  loc_destino_id: string;
  loc_destino_codigo: string;
  qty_swap: number;
  qty_emprestimo: number;
  swaps: OperacaoSwap[];
  emprestimos: OperacaoEmprestimo[];
  reservas_a_cancelar: string[];
}

/** Plano completo da wave (vários SKUs). */
export interface PlanoMiniSwap {
  galpao_id: string;
  pedido_ids: string[];
  demandas_planejadas: PlanoDemanda[];
  /** SKUs que entraram na wave mas foram skipados (1 loc só, inviável, etc). */
  demandas_skipadas: Array<{ produto_id: string; motivo: string }>;
}
