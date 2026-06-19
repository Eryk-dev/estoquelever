import type { LiveStockEntry } from "@/lib/wms/live-stock";

export type CrossStatus = "sugestao" | "confirmado" | "bloqueado";

export interface CrossPar {
  id: number;
  sku_a: string;
  sku_b: string;
  relacao: string;
  status: CrossStatus;
  fonte: string;
}

export interface ProdutoMin {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  imagens: string[] | null;
  tier_qualidade: string | null;
}

export interface CrossEquivalente extends ProdutoMin {
  relacao: string;
  status: CrossStatus;
  fonte: string;
  estoquePorGalpao: Record<string, LiveStockEntry>;
}

export interface EquivalentesDaPeca {
  sku: string;
  equivalentes: CrossEquivalente[];
}

/** Par sempre normalizado a<b pra não duplicar A↔B. */
export function normalizarPar(a: string, b: string): { sku_a: string; sku_b: string } {
  return a < b ? { sku_a: a, sku_b: b } : { sku_a: b, sku_b: a };
}

/** Recusa ligar uma peça com ela mesma. */
export function saoLigaveis(a: string, b: string): boolean {
  return a !== b;
}

export function outroLado(par: { sku_a: string; sku_b: string }, sku: string): string {
  return par.sku_a === sku ? par.sku_b : par.sku_a;
}

/**
 * Mapeia o status do caderno pro vocabulário que a regra de troca usa.
 * A regra (trocas-equivalencia-regra.ts) NÃO muda — só a fonte do dado.
 */
export function statusParaRegra(
  status: CrossStatus,
): "verificado" | "bloqueado" | null {
  if (status === "confirmado") return "verificado";
  if (status === "bloqueado") return "bloqueado";
  return null;
}

/**
 * Monta a lista de equivalentes DIRETOS de `sku` (sem corrente transitiva),
 * juntando produto + estoque (ledger) + status do par.
 */
export function montarEquivalentes(input: {
  sku: string;
  pares: CrossPar[];
  produtosPorSku: Record<string, ProdutoMin>;
  estoquePorSku: Record<string, Record<string, LiveStockEntry>>;
  incluirBloqueado: boolean;
}): EquivalentesDaPeca {
  const equivalentes: CrossEquivalente[] = [];
  for (const par of input.pares) {
    if (!input.incluirBloqueado && par.status === "bloqueado") continue;
    const outro = outroLado(par, input.sku);
    const prod = input.produtosPorSku[outro];
    if (!prod) continue;
    equivalentes.push({
      ...prod,
      relacao: par.relacao,
      status: par.status,
      fonte: par.fonte,
      estoquePorGalpao: input.estoquePorSku[outro] ?? {},
    });
  }
  return { sku: input.sku, equivalentes };
}
