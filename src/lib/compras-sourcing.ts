import { calcularNecessidadeLiquida } from "./compras-necessidade";

export interface NecessidadeGalpaoInput {
  galpaoId: string;
  /** Σ(quantidade_pedida − quantidade_pega) dos pedidos deste SKU NESTE galpão. */
  demanda: number;
  /** Σ siso_estoque.disponivel do SKU NESTE galpão. */
  livre: number;
  /** Σ max(0, solicitada − recebida) das OCs deste SKU chegando NESTE galpão. */
  transito: number;
}

export interface NecessidadeGalpaoLinha {
  galpaoId: string;
  necessidade: number;
}

export interface NecessidadeSkuResult {
  /** Soma das necessidades por galpão (já clampadas em ≥0 cada). */
  total: number;
  porGalpao: NecessidadeGalpaoLinha[];
}

/**
 * Necessidade líquida de um SKU netada POR GALPÃO e somada.
 *
 * Cada galpão neta a própria demanda contra o próprio estoque livre + em-trânsito
 * (uma OC chegando em CWB NÃO reduz a necessidade de SP — corrige o em-trânsito
 * global). Clamp por galpão: excesso num galpão não compensa falta em outro.
 *
 * A quantidade aqui é só a SUGESTÃO — o comprador edita na tela quantas unidades
 * vai comprar (sem arredondar por caixa/mínimo/múltiplo).
 */
export function calcularNecessidadeSkuPorGalpao(
  rows: NecessidadeGalpaoInput[],
): NecessidadeSkuResult {
  const porGalpao = rows.map((r) => ({
    galpaoId: r.galpaoId,
    necessidade: calcularNecessidadeLiquida({
      demandaAberta: r.demanda,
      estoqueLivre: r.livre,
      emTransito: r.transito,
    }).necessidadeLiquida,
  }));
  const total = porGalpao.reduce((soma, g) => soma + g.necessidade, 0);
  return { total, porGalpao };
}
