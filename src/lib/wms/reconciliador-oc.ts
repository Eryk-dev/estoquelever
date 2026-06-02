// ──────────────────────────────────────────────────────────────────
// Reconciliador de saldo OC — quando entra estoque, devolve ao picking
// os pedidos parados por falta (FIFO, mais antigo primeiro), usando só
// saldo LIVRE. Disparado pelo gancho de mov E em ledger.ts.

/**
 * FIFO estrito: percorre os pendentes (já ordenados por antiguidade) e marca
 * `libera=true` enquanto o saldo livre cobre o `outstanding` de cada um. Ao
 * encontrar o primeiro que não cabe, bloqueia o resto (não fura a fila).
 */
export function selecionarLiberaveisFifo<T extends { outstanding: number }>(
  pendentesOrdenados: T[],
  saldoLivre: number,
): Array<T & { libera: boolean }> {
  let restante = Math.max(0, saldoLivre);
  let bloqueado = false;
  return pendentesOrdenados.map((item) => {
    const need = Math.max(0, item.outstanding);
    if (!bloqueado && need > 0 && need <= restante) {
      restante -= need;
      return { ...item, libera: true };
    }
    if (need > 0) bloqueado = true;
    return { ...item, libera: false };
  });
}
