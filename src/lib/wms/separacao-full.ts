/**
 * Separação Full — constantes + helpers puros.
 *
 * Envio de estoque ao CDF do Mercado Livre ("Full"), sem pedido-fantasma no
 * Tiny: cria → separa → fecha um envio internamente no WMS. Dá baixa (S) no
 * próprio pick; sem NF, sem Tiny.
 *
 * Decisão de modelagem: flag boolean `siso_pedidos.separacao_full` + reuso dos
 * mesmos `status_separacao` (aguardando_separacao → em_separacao → separado),
 * com `fechado` como etapa VIRTUAL (`separado` + `fechado_em IS NOT NULL`).
 * Clona o padrão de `separacao-futura.ts`. Ver migration 20260701_separacao_full.sql.
 */

/** Marcador em siso_pedidos.marcadores[] pra visibilidade (espelha "VENDA_DIRETA"). */
export const MARCADOR_FULL = "FULL";

/** true quando o pedido pertence à lane Full (envio ao CDF do ML). */
export function isPedidoFull(pedido: { separacao_full?: boolean | null }): boolean {
  return pedido.separacao_full === true;
}
