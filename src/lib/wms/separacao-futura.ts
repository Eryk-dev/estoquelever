/**
 * Separação Futura — constantes + helpers puros.
 *
 * Vendas ML pagas cuja etiqueta o ML segura pra data futura
 * (`shipment.substatus = buffered`) entram numa pista futura: reservam estoque
 * no ato, separam fisicamente já, compram já se faltar — SEM gerar NF até a
 * etiqueta liberar. Quando libera, a promoção flipa a flag e segue o fluxo
 * normal (NF + agrupamento → embalagem → expedição).
 *
 * Decisão de modelagem: flag boolean `siso_pedidos.separacao_futura` + reuso dos
 * mesmos `status_separacao` (não estados dedicados). Ver migration
 * 20260624_separacao_futura.sql.
 */

/** Marcador aplicado no pedido Tiny pra visibilidade (≠ NF). */
export const MARCADOR_FUTURA = "SEP FUTURA";

/** Tag em siso_pedidos.separacao_tags[] — badge que viaja até a embalagem. */
export const TAG_FUTURA = "FUTURA";

/** substatus do shipment ML que marca "etiqueta segurada p/ data futura". */
export const SUBSTATUS_FUTURA = "buffered";

const BUFFER_DIAS = 14;
const FALLBACK_HORAS = 90 * 24;

/**
 * TTL (em horas) da reserva de uma venda futura: de agora até
 * `prazoEnvio + 14 dias`. Uma etiqueta buffered pode estar segurada semanas à
 * frente — o TTL fixo de 30d do fluxo normal expiraria antes da etiqueta
 * liberar (= oversold de novo). Fallback de 90d quando não há prazo ou o prazo
 * já passou (nunca retorna TTL <= 0).
 *
 * Puro (now injetável) pra teste.
 */
export function ttlHorasReservaFutura(
  prazoEnvio: string | null | undefined,
  now: Date = new Date(),
): number {
  if (!prazoEnvio) return FALLBACK_HORAS;
  const prazo = new Date(prazoEnvio);
  if (Number.isNaN(prazo.getTime())) return FALLBACK_HORAS;
  const alvoMs = prazo.getTime() + BUFFER_DIAS * 24 * 3600 * 1000;
  const horas = Math.ceil((alvoMs - now.getTime()) / (3600 * 1000));
  return horas > 0 ? horas : FALLBACK_HORAS;
}
