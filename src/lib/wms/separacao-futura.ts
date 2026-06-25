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

/** status do shipment ML em que NÃO se promove (venda morta — não gera NF). */
const STATUS_NAO_PROMOVE = new Set(["cancelled", "not_delivered"]);

/**
 * Ação a tomar sobre um pedido na pista futura, dado o `status`/`substatus`
 * ATUAIS da etiqueta no ML. Pura (testável).
 *
 * - `manter`   — etiqueta ainda segurada (`buffered`) OU shipment cancelado/morto
 *                (`status` cancelled/not_delivered): NÃO promove. Segura uma NF de
 *                venda cancelada (o cancelamento é tratado pelo fluxo de cancel).
 * - `ignorar`  — sem leitura de substatus (ML off / shipment não encontrado):
 *                não decide nesse run.
 * - `promover` — etiqueta LIBEROU (substatus != buffered, shipment ativo): vira
 *                fluxo NORMAL e segue a decisao do pedido IGUAL ao fluxo normal
 *                (propria/transferência geram NF→embalagem; OC gera NF + segue a
 *                compra — validacao_oc). Sem casos especiais por estoque.
 *
 * ⚠ Só decide "se a etiqueta liberou". NÃO decide "se o pedido está comprometido"
 *   (decisao_final != null) — isso é checado no chamador (uma troca pendente,
 *   decisao_final=null, NUNCA promove, senão geraria NF de venda não-aprovada).
 */
export type AcaoFutura = "manter" | "ignorar" | "promover";

export function classificarPromocaoFutura(
  substatus: string | null | undefined,
  status?: string | null | undefined,
): AcaoFutura {
  if (status != null && STATUS_NAO_PROMOVE.has(status)) return "manter";
  if (substatus == null) return "ignorar";
  if (substatus === SUBSTATUS_FUTURA) return "manter";
  return "promover";
}

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
