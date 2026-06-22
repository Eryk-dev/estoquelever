/**
 * Decisão pura de qual galpão usar na separação ao APROVAR uma transferência.
 *
 * Por que existe: na aprovação humana de transferência, /pedidos/aprovar
 * re-rodava `rotearPedidoDoBanco` contra `siso_estoque.disponivel` LIVE. Mas a
 * R `reserva_pedido` criada no INTAKE (webhook) já zerou o `disponivel` do
 * galpão de cobertura — então o re-roteamento via "ninguém cobre 100%" e caía
 * no fallback que jogava `separacao_galpao_id` pra casa, ÓRFÃO da reserva (que
 * ficou no galpão real). Resultado: pedido na fila errada, "saldo 0, sem loc",
 * impossível separar.
 *
 * Regra: se há R viva pro pedido, o galpão dela É o plano comprometido — vence
 * o re-roteamento. Sem R viva, usa o resultado da rota; se nem a rota cobre,
 * fallback pra casa (mantém o comportamento antigo só nesse caso genuíno).
 */
export type RotaDecisaoSimples = "propria" | "transferencia" | "oc";

export interface EscolhaGalpaoTransferencia {
  galpao: string;
  /** true = plano com cobertura (reserva viva ou rota cobriu); false = fallback casa */
  cobertura: boolean;
  origem: "reserva_viva" | "rota" | "fallback_casa";
}

export function escolherGalpaoSeparacaoTransferencia(opts: {
  /** galpão da(s) R `reserva_pedido` vivas do pedido; null se não houver */
  galpaoReservaViva: string | null;
  rotaDecisao: RotaDecisaoSimples;
  rotaGalpao: string | null;
  /** galpão casa da empresa origem (fallback) */
  galpaoCasa: string;
}): EscolhaGalpaoTransferencia {
  if (opts.galpaoReservaViva) {
    return { galpao: opts.galpaoReservaViva, cobertura: true, origem: "reserva_viva" };
  }
  if (opts.rotaDecisao === "transferencia" && opts.rotaGalpao) {
    return { galpao: opts.rotaGalpao, cobertura: true, origem: "rota" };
  }
  return { galpao: opts.galpaoCasa, cobertura: false, origem: "fallback_casa" };
}
