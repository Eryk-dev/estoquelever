// ──────────────────────────────────────────────────────────────────
// Alocação de contagem parcial no "Encontrei" da validação OC.
// O operador conta N unidades na prateleira; a contagem é distribuída
// entre os itens pendentes liberando o MAIOR número possível de pedidos
// por inteiro (menor quantidade primeiro). A sobra que não cobre o
// próximo item inteiro vira pick parcial dele (o restante vai pra
// compras); itens sem cobertura nenhuma ficam esgotados (compras na
// quantidade cheia). Pura — testável sem IO.

export interface ItemAlocavel {
  id: string;
  /** Quantidade que o item precisa separar (quantidade_pedida). */
  qty: number;
}

export type PlanoAlocacao =
  | { tipo: "cobre_total" }
  | { tipo: "parcial"; qty_pega: number }
  | { tipo: "esgotado" };

export function alocarContagem(
  itens: ItemAlocavel[],
  qtyContada: number,
): Map<string, PlanoAlocacao> {
  const ordenados = [...itens].sort(
    (a, b) => a.qty - b.qty || a.id.localeCompare(b.id),
  );
  let restante = Math.max(0, qtyContada);
  const plano = new Map<string, PlanoAlocacao>();
  for (const item of ordenados) {
    if (item.qty <= restante) {
      plano.set(item.id, { tipo: "cobre_total" });
      restante -= item.qty;
    } else if (restante > 0) {
      plano.set(item.id, { tipo: "parcial", qty_pega: restante });
      restante = 0;
    } else {
      plano.set(item.id, { tipo: "esgotado" });
    }
  }
  return plano;
}
