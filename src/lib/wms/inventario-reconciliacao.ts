// Função pura que reconcilia uma sessão de inventário temporalmente.
// Não toca em I/O — recebe snapshot, devolve divergências calculadas.
//
// Conceitos:
//   - Quádrupla = (localizacao_id, produto_id, empresa_dona_id, sessao)
//   - Cutoff = instante em que a aprovação foi disparada. Movs após o cutoff
//     ficam fora desta sessão.
//   - Saldo esperado = saldo na quádrupla no instante de T_ref:
//       T_ref = max(contado_em) das contagens da quádrupla, OU
//       contagem_finalizada_em da loc, se a quádrupla nasceu de "loc visitada
//       e vazia" sem bipes.
//     Para reconstruí-lo, pegamos o `saldo_anterior` da primeira mov
//     EFETIVA da quádrupla com `criado_em > T_ref`. Se não houver, usamos
//     o saldo atual.
//
// "Mov efetiva" = mov não-estornada (não é estorno E não foi estornada por
// outra) E não é da própria sessão (origem_tipo='inventario' + origem_id=sessao).

export interface ContagemInput {
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  qty_contada: number;
  contado_em: string; // ISO timestamp
}

export interface LocVisitadaInput {
  localizacao_id: string;
  contagem_finalizada_em: string; // ISO — só locs efetivamente visitadas
}

export interface SaldoAtualInput {
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  saldo: number;
  custo_medio: number;
}

export interface MovInput {
  id: string;
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  criado_em: string;
  saldo_anterior: number;
  saldo_posterior: number;
  origem_tipo: string;
  origem_id: string | null;
  estorno_de: string | null;
}

export interface ReconciliarInput {
  sessao_id: string;
  cutoff_em: string; // ISO
  contagens: ContagemInput[];
  locs_visitadas: LocVisitadaInput[];
  saldos_atuais: SaldoAtualInput[];
  movs: MovInput[];
}

export interface DivergenciaCalculada {
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  saldo_esperado: number;
  qty_contada_final: number;
  delta: number; // qty_contada - saldo_esperado
  valor_financeiro: number;
}

export function reconciliarTemporal(_input: ReconciliarInput): DivergenciaCalculada[] {
  return [];
}
