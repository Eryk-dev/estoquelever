// Função pura que reconcilia uma sessão de inventário temporalmente.
// Não toca em I/O — recebe snapshot, devolve divergências calculadas.
//
// Modelo 3D (Fase 5 Batch C): empresa_dona deixou de ser coordenada física.
// Agrupa-se contagens por **tripla** (localizacao_id, produto_id, sessao).
//
// Conceitos:
//   - Tripla = (localizacao_id, produto_id) dentro da sessão
//   - Cutoff = instante em que a aprovação foi disparada. Movs após o cutoff
//     ficam fora desta sessão.
//   - Saldo esperado = saldo na tripla no instante de T_ref:
//       T_ref = max(contado_em) das contagens da tripla, OU
//       contagem_finalizada_em da loc, se a tripla nasceu de "loc visitada
//       e vazia" sem bipes.
//     Para reconstruí-lo, pegamos o `saldo_anterior` da primeira mov
//     EFETIVA da tripla com `criado_em > T_ref`. Se não houver, usamos
//     o saldo atual.
//
// "Mov efetiva" = mov não-estornada (não é estorno E não foi estornada por
// outra) E não é da própria sessão (origem_tipo='inventario_*' + origem_id=sessao).

export interface ContagemInput {
  localizacao_id: string;
  produto_id: string;
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
  saldo: number;
  custo_medio: number;
}

export interface MovInput {
  id: string;
  localizacao_id: string;
  produto_id: string;
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
  saldo_esperado: number;
  qty_contada_final: number;
  delta: number; // qty_contada - saldo_esperado
  valor_financeiro: number;
}

// Helper: primeira mov "efetiva" na tripla com criado_em > t_ref
function primeiraMovEfetiva(
  movs: MovInput[],
  loc: string,
  prod: string,
  t_ref: string,
  sessaoId: string,
  cutoff: string,
  estornadas: Set<string>,
): MovInput | null {
  const candidatos = movs
    .filter(
      (m) =>
        m.localizacao_id === loc &&
        m.produto_id === prod &&
        m.criado_em > t_ref &&    // strict: bipe instantâneo é "antes" da mov concorrente
        m.criado_em <= cutoff &&   // inclusive: cutoff fecha a janela da sessão
        m.estorno_de === null &&
        !estornadas.has(m.id) &&
        !(
          (m.origem_tipo === "inventario_ganho" ||
            m.origem_tipo === "inventario_perda" ||
            m.origem_tipo === "inventario_inicial" ||
            m.origem_tipo === "inventario") && // compat com histórico legado
          m.origem_id === sessaoId
        ),
    )
    .sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  return candidatos[0] ?? null;
}

export function reconciliarTemporal(input: ReconciliarInput): DivergenciaCalculada[] {
  const result: DivergenciaCalculada[] = [];

  // Agrega contagens por tripla
  const agregado = new Map<string, { loc: string; prod: string; qty: number; t_ref: string }>();
  for (const c of input.contagens) {
    const k = `${c.localizacao_id}|${c.produto_id}`;
    const cur = agregado.get(k);
    if (cur) {
      cur.qty += c.qty_contada;
      if (c.contado_em > cur.t_ref) cur.t_ref = c.contado_em;
    } else {
      agregado.set(k, {
        loc: c.localizacao_id,
        prod: c.produto_id,
        qty: c.qty_contada,
        t_ref: c.contado_em,
      });
    }
  }

  const saldoMap = new Map<string, { saldo: number; custo: number }>();
  for (const s of input.saldos_atuais) {
    saldoMap.set(`${s.localizacao_id}|${s.produto_id}`, {
      saldo: s.saldo,
      custo: s.custo_medio,
    });
  }

  // Para cada loc visitada, descobrir triplas SEM contagem mas com
  // saldo presente AGORA → divergência candidata com qty=0.
  // T_ref = contagem_finalizada_em da loc.
  const locsVisitadasMap = new Map<string, string>();
  for (const lv of input.locs_visitadas) {
    locsVisitadasMap.set(lv.localizacao_id, lv.contagem_finalizada_em);
  }

  for (const s of input.saldos_atuais) {
    if (s.saldo <= 0) continue;
    const k = `${s.localizacao_id}|${s.produto_id}`;
    if (agregado.has(k)) continue;
    const finalizadaEm = locsVisitadasMap.get(s.localizacao_id);
    if (!finalizadaEm) continue; // loc não visitada → ignora
    agregado.set(k, {
      loc: s.localizacao_id,
      prod: s.produto_id,
      qty: 0,
      t_ref: finalizadaEm,
    });
  }

  // Pre-computa IDs estornados — invariante em todas as chamadas a primeiraMovEfetiva
  const estornadas = new Set<string>();
  for (const m of input.movs) {
    if (m.estorno_de) estornadas.add(m.estorno_de);
  }

  for (const v of agregado.values()) {
    const k = `${v.loc}|${v.prod}`;
    const s = saldoMap.get(k);
    const saldo_atual = s?.saldo ?? 0;
    const custo = s?.custo ?? 0;
    const proxima = primeiraMovEfetiva(input.movs, v.loc, v.prod, v.t_ref, input.sessao_id, input.cutoff_em, estornadas);
    const saldo_esperado = proxima ? proxima.saldo_anterior : saldo_atual;

    const delta = v.qty - saldo_esperado;
    if (delta === 0) continue;
    result.push({
      localizacao_id: v.loc,
      produto_id: v.prod,
      saldo_esperado,
      qty_contada_final: v.qty,
      delta,
      valor_financeiro: custo * delta,
    });
  }

  return result;
}
