// Distribui uma nova quantidade pega (parcial) entre os items de um wave
// consolidado (mesmo SKU), descontando o que CADA item já tinha pego antes
// (`quantidade_pega`). Sem isso, re-fazer parcial num item já parcial nunca
// fecha o item: o residual era calculado sobre `quantidade_pedida` em vez de
// sobre o que ainda falta. FCFS — abastece um item por vez na ordem recebida.
export interface ItemDistribuicao {
  id: number | string;
  quantidade_pedida: number;
  quantidade_pega?: number | null;
}

export interface DistribuicaoResultado<T> {
  item: T;
  /** Quanto da nova qty pega foi alocado a este item (limitado ao que falta). */
  qty_para_este: number;
  /** Quanto ainda falta neste item DEPOIS desta rodada (0 = item completo). */
  qty_residual: number;
}

export function distribuirQtyPega<T extends ItemDistribuicao>(
  items: T[],
  novaQtyPega: number,
): DistribuicaoResultado<T>[] {
  let restante = Math.max(0, novaQtyPega);
  return items.map((item) => {
    const jaPega = Number(item.quantidade_pega ?? 0);
    const falta = Math.max(0, Number(item.quantidade_pedida) - jaPega);
    const qtyParaEste = Math.min(falta, restante);
    restante -= qtyParaEste;
    return { item, qty_para_este: qtyParaEste, qty_residual: falta - qtyParaEste };
  });
}
