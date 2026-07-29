/**
 * Na validação OC normal, só o item ainda pendente de decisão deve continuar
 * na lista. Depois de confirmar Esgotado ele vira `aguardando_compra` e precisa
 * sair mesmo quando o pedido misto continua em `validacao_oc`.
 *
 * O modo pick-OC é diferente: ele existe justamente para separar itens que já
 * passaram por compras, então preserva esses estados.
 */
export function itemVisivelNoChecklistPorCompra(
  compraStatus: string | null | undefined,
  isPickOC: boolean,
): boolean {
  if (compraStatus === "indisponivel" || compraStatus === "cancelado") {
    return false;
  }

  if (!isPickOC && compraStatus != null && compraStatus !== "oc_pendente") {
    return false;
  }

  return true;
}
