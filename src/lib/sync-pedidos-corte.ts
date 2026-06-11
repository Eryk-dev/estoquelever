/**
 * Corte de sincronização de pedidos (siso_empresas.sync_pedidos_desde).
 *
 * Quando uma empresa migra pro WMS, os pedidos anteriores à virada já foram
 * tratados pelo processo antigo — puxá-los de novo criaria pedidos, reservas
 * e separações duplicadas. O corte diz a partir de quando o WMS é dono dos
 * pedidos da empresa.
 *
 * GRANULARIDADE: o Tiny só expõe o DIA de criação do pedido (campo `data`,
 * YYYY-MM-DD, sem horário). Então:
 *   - Polling (fallback): só puxa dias INTEIRAMENTE pós-corte — corte
 *     2026-06-15 14:00 ⇒ puxa do dia 16 em diante; corte à meia-noite ⇒
 *     inclui o próprio dia. Pedidos da tarde do dia da virada entram pelo
 *     webhook (caminho primário, tempo real).
 *   - Webhook: ignora pedido cujo dia de criação é ANTERIOR ao dia do corte
 *     (mata webhook de atualização de pedido velho). Pedido do próprio dia
 *     do corte passa.
 *
 * Pra uma virada sem buraco nem duplicata, configure o corte como MEIA-NOITE
 * do dia em que o WMS assume.
 */

const TZ = "America/Sao_Paulo";

/** Dia (YYYY-MM-DD) de um timestamp no fuso de São Paulo. */
export function diaEmSaoPaulo(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

function ehMeiaNoiteEmSaoPaulo(iso: string): boolean {
  return (
    new Date(iso).toLocaleTimeString("en-GB", {
      timeZone: TZ,
      hour12: false,
    }) === "00:00:00"
  );
}

/**
 * Primeiro dia (YYYY-MM-DD) cujos pedidos são todos pós-corte: o próprio dia
 * se o corte é meia-noite exata em SP, senão o dia seguinte.
 */
export function primeiroDiaInteiroPosCorte(corte: string): string {
  const dia = diaEmSaoPaulo(corte);
  if (ehMeiaNoiteEmSaoPaulo(corte)) return dia;
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * O pedido (data de criação Tiny, YYYY-MM-DD) foi criado em dia anterior ao
 * dia do corte? Data ausente/ilegível ou corte ausente ⇒ false (não bloqueia).
 */
export function criadoAntesDoDiaDoCorte(
  dataPedido: string | null | undefined,
  corte: string | null | undefined,
): boolean {
  if (!corte || !dataPedido) return false;
  const dia = dataPedido.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false;
  return dia < diaEmSaoPaulo(corte);
}
