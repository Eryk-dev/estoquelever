import type { LiveStockEntry } from "@/lib/wms/live-stock";

export type CrossStatus = "sugestao" | "confirmado" | "bloqueado";
export type FiltroOrigemSugestao =
  | "todas"
  | "manual"
  | "planilha"
  | "automatica";

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

export function origemSugestao(
  fonte: string,
): Exclude<FiltroOrigemSugestao, "todas"> {
  const normalizada = fonte.trim().toLowerCase();
  if (
    normalizada.includes("planilha") ||
    normalizada.includes("import") ||
    normalizada.includes("csv") ||
    normalizada.includes("xlsx")
  ) {
    return "planilha";
  }
  return normalizada.endsWith("_auto") ? "automatica" : "manual";
}

export function filtrarSugestoesPorOrigem<T extends { fonte: string }>(
  itens: T[],
  filtro: FiltroOrigemSugestao,
): T[] {
  if (filtro === "todas") return itens;
  return itens.filter((item) => origemSugestao(item.fonte) === filtro);
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

/** Normaliza um código OEM pra comparar (sem separadores, caixa alta). */
export function normalizarOem(codigo: string): string {
  return codigo.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Códigos OEM em comum entre duas peças (normalizados, dedup). Base da dica
 * "compartilham OEM X" na fila e do match por OEM compartilhado.
 */
export function oemEmComum(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): string[] {
  if (!a || !b) return [];
  const setB = new Set(b.map(normalizarOem).filter(Boolean));
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const codigo of a) {
    const n = normalizarOem(codigo);
    if (n && setB.has(n) && !vistos.has(n)) {
      vistos.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Uma opção de fornecedor já achatada pro pool "Onde comprar". */
export interface FornecedorPoolEntrada {
  fornecedorId: string | null;
  nome: string;
  codigo_fornecedor: string | null;
  custo_unitario: number | null;
  galpao_id: string | null;
  galpao_nome: string | null;
  preferencial: boolean;
}

export interface OndeComprarLinha extends FornecedorPoolEntrada {
  /** De qual SKU do grupo vem esta opção. */
  sku: string;
  origem: "proprio" | "equivalente";
}

/**
 * Pool "Onde comprar": junta os fornecedores do próprio SKU + dos equivalentes
 * (já confirmados) numa lista só, mantendo a proveniência (de qual SKU vem).
 * Ordem: próprio primeiro, depois cada equivalente na ordem de `grupoSkus`
 * (cada bloco já vem preferencial-first do loader).
 */
export function montarOndeComprar(input: {
  selfSku: string;
  grupoSkus: string[];
  fornecedoresPorSku: Record<string, FornecedorPoolEntrada[]>;
}): OndeComprarLinha[] {
  const out: OndeComprarLinha[] = [];
  for (const sku of input.grupoSkus) {
    const entradas = input.fornecedoresPorSku[sku] ?? [];
    for (const e of entradas) {
      out.push({ ...e, sku, origem: sku === input.selfSku ? "proprio" : "equivalente" });
    }
  }
  return out;
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
