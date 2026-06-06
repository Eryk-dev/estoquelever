export interface ItemCancelavel {
  id: string;
  sku: string | null;
  mov_saida_id: string | null;
  quantidade_pega: number | null;
}

export interface ClassificacaoCancelamento {
  /** Itens já picados/em-pick: NÃO estornar (auditoria); viram pendência de devolução manual. */
  pegos: ItemCancelavel[];
  /** Itens sem pick: liberar a reserva R. */
  naoPegos: ItemCancelavel[];
}

/**
 * D1 (P007): classifica itens de um pedido em separação parcial.
 * Pego = tem mov_saida_id OU quantidade_pega>0 (saída física já ocorreu).
 * Não-pego = nenhum dos dois (só reserva R viva).
 */
export function classificarItensParaCancelamento(
  itens: ItemCancelavel[],
): ClassificacaoCancelamento {
  const pegos: ItemCancelavel[] = [];
  const naoPegos: ItemCancelavel[] = [];
  for (const it of itens) {
    const pego = !!it.mov_saida_id || Number(it.quantidade_pega ?? 0) > 0;
    if (pego) pegos.push(it);
    else naoPegos.push(it);
  }
  return { pegos, naoPegos };
}
