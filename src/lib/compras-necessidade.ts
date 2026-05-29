import type { StatusCobertura } from "@/lib/wms/cobertura";

export interface NecessidadeSkuInput {
  /** Σ(quantidade_pedida − quantidade_pega) dos pedidos que AINDA precisam do SKU
   *  (em `aguardando_compra` E em `comprado` — incluir os comprados evita sub-compra). */
  demandaAberta: number;
  /** Σ siso_estoque.disponivel (AO VIVO) do produto do SKU, somado entre galpões. */
  estoqueLivre: number;
  /** Σ max(0, solicitada − recebida) dos itens em `comprado` (mercadoria a caminho). */
  emTransito: number;
}

export interface NecessidadeSkuResult extends NecessidadeSkuInput {
  /** Quanto ainda falta comprar AGORA = max(0, demanda − livre − em-trânsito). */
  necessidadeLiquida: number;
}

export function calcularNecessidadeLiquida(input: NecessidadeSkuInput): NecessidadeSkuResult {
  const demandaAberta = Math.max(0, input.demandaAberta);
  const estoqueLivre = Math.max(0, input.estoqueLivre);
  const emTransito = Math.max(0, input.emTransito);
  const necessidadeLiquida = Math.max(0, demandaAberta - estoqueLivre - emTransito);
  return { demandaAberta, estoqueLivre, emTransito, necessidadeLiquida };
}

const SEVERIDADE: Record<StatusCobertura, number> = {
  critico: 4,
  lead_time_risco: 3,
  atencao: 2,
  ok: 1,
  sem_giro: 0,
};

/** Retorna o status MAIS severo entre dois (usado pra agregar cobertura entre galpões). */
export function piorStatusCobertura(a: StatusCobertura, b: StatusCobertura): StatusCobertura {
  return SEVERIDADE[a] >= SEVERIDADE[b] ? a : b;
}
