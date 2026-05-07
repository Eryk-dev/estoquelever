// Estrutura de produto no catálogo (espelha siso_produtos_catalogo)
export interface ProdutoCatalogo {
  id: string;
  sku: string;
  tiny_id: number | null;
  nome: string;
  descricao: string | null;
  fornecedor: string | null;
  marca: string | null;
  imagem_url: string | null;
  gtin: string | null;
  oem: string[];
  compatibility_v2: { vehicles?: VeiculoJsonb[] };
  localizacao: string | null;
  sincronizado_em: string | null;
  criado_em: string;
  atualizado_em: string;
}

export interface VeiculoJsonb {
  brand: string;
  model: string;
  year_start: number | null;
  year_end: number | null;
  variant: string | null;
}

export interface OemEntry {
  id: number;
  codigo: string;
  origem: "extracao_tiny" | "manual";
  adicionado_por: string | null;
  adicionado_por_nome: string | null;
  adicionado_em: string;
  pode_remover: boolean;
}

export interface VeiculoEntry {
  id: number;
  marca: string;
  modelo: string;
  ano_inicio: number | null;
  ano_fim: number | null;
  variante: string | null;
  adicionado_por: string | null;
  adicionado_por_nome: string | null;
  adicionado_em: string;
  pode_remover: boolean;
}

/**
 * Resumo numérico de estoque (saldo/reservado/disponível) usado em vários
 * pontos do módulo Cross. Extraído para evitar duplicação inline entre
 * `EstoqueGalpao` e `Equivalente.estoque_por_galpao`.
 */
export interface EstoqueResumo {
  saldo: number;
  reservado: number;
  disponivel: number;
}

/**
 * Estoque agregado por galpão usado pelo módulo Cross (visão de catálogo /
 * detalhe de produto). Combina o resumo numérico (`EstoqueResumo`) com
 * metadados do depósito principal e localização física.
 *
 * NOTA: Intencionalmente distinto de `GalpaoEstoque` em `src/types/index.ts`,
 * que pertence ao fluxo de pedidos (order-flow-scoped) e tem outra forma. Os
 * nomes invertidos (`EstoqueGalpao` vs `GalpaoEstoque`) são propositais para
 * manter alinhamento com o spec/plano do Cross — não renomear sem atualizar
 * a documentação correspondente.
 */
export interface EstoqueGalpao extends EstoqueResumo {
  deposito_nome: string | null;
  localizacao: string | null;
}

export interface ResultadoBusca {
  sku: string;
  nome: string;
  fornecedor: string | null;
  marca: string | null;
  imagem_url: string | null;
  localizacao: string | null;
  oems: string[];
  estoque_total: number;
  cross_count: number;  // qtd de SKUs que compartilham >= 1 OEM (pra esconder botão Cross-Refs quando 0)
  match: "sku_exato" | "sku_prefixo" | "oem" | "nome";
}

/**
 * Versão "rápida" do equivalente — só dados do cache local, sem estoque por
 * galpão. Usado pra rendering inline na lista de busca onde velocidade
 * importa mais que precisão de estoque.
 *
 * `origem` distingue como o equivalente foi descoberto:
 *  - 'oem'       — compartilha pelo menos 1 OEM (descoberta automática)
 *  - 'link'      — operador linkou os 2 SKUs manualmente (sem precisar de OEM)
 *  - 'oem+link'  — ambos
 */
export interface EquivalenteRapido {
  sku: string;
  nome: string;
  fornecedor: string | null;
  marca: string | null;
  imagem_url: string | null;
  localizacao: string | null;
  oems: string[];
  oems_compartilhados: string[];
  /**
   * Como esse SKU foi descoberto a partir do SKU base:
   *   'oem'      — compartilha pelo menos 1 OEM diretamente
   *   'link'     — link manual direto entre os 2 SKUs
   *   'oem+link' — ambos (OEM + link direto)
   *   'cadeia'   — alcançado via transitividade (cluster), sem aresta direta
   */
  origem: "oem" | "link" | "oem+link" | "cadeia";
}

export interface ProdutoLink {
  id: number;
  sku_outro: string;  // o SKU "do outro lado" do link, relativo ao produto sendo visto
  motivo: string | null;
  adicionado_por: string | null;
  adicionado_por_nome: string | null;
  adicionado_em: string;
  pode_remover: boolean;
}

export interface RespostaBusca {
  query: string;
  tipo_detectado: "sku" | "oem" | "nome";
  total: number;
  resultados: ResultadoBusca[];
}

export interface DetalheProduto {
  sku: string;
  nome: string;
  descricao: string | null;
  fornecedor: string | null;
  marca: string | null;
  imagem_url: string | null;
  gtin: string | null;
  localizacao: string | null;
  sincronizado_em: string | null;
  oems: OemEntry[];
  veiculos: VeiculoEntry[];
}

export interface Equivalente {
  sku: string;
  nome: string;
  imagem_url: string | null;
  localizacao: string | null;
  oems_compartilhados: string[];
  estoque_por_galpao: Record<string, EstoqueResumo>;
  estoque_total: number;
}

export type TipoBusca = "auto" | "sku" | "oem" | "nome";
