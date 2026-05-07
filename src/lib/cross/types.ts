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

export interface EstoqueGalpao {
  saldo: number;
  reservado: number;
  disponivel: number;
  deposito_nome: string | null;
  localizacao: string | null;
}

export interface ResultadoBusca {
  sku: string;
  nome: string;
  fornecedor: string | null;
  marca: string | null;
  imagem_url: string | null;
  oems: string[];
  estoque_total: number;
  match: "sku_exato" | "oem" | "nome";
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
  sincronizado_em: string | null;
  oems: OemEntry[];
  veiculos: VeiculoEntry[];
  estoque_por_galpao: Record<string, EstoqueGalpao>;
  equivalentes: Equivalente[];
}

export interface Equivalente {
  sku: string;
  nome: string;
  imagem_url: string | null;
  oems_compartilhados: string[];
  estoque_por_galpao: Record<string, { saldo: number; reservado: number; disponivel: number }>;
  estoque_total: number;
}

export type TipoBusca = "auto" | "sku" | "oem" | "nome";
