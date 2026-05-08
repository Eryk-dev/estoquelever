// Reflete schema de docs/superpowers/specs/2026-05-07-wms-design.md §3
// e migration supabase/migrations/20260508_wms_foundation.sql.

export type TipoLocalizacao =
  | "picking"
  | "overstock"
  | "recebimento"
  | "expedicao"
  | "quarentena";

export type TipoMov = "E" | "S" | "R" | "L";

export type OrigemTipo =
  | "compra_manual"
  | "lancamento_retroativo"
  | "nf_venda"
  | "nf_devolucao_cliente"
  | "nf_devolucao_avariada"
  | "nf_devolucao_fornecedor"
  | "transferencia_galpao"
  | "transferencia_localizacao"
  | "emprestimo"
  | "reserva_pedido"
  | "liberacao_reserva"
  | "troca_sku_in"
  | "troca_sku_out"
  | "ajuste_manual"
  | "inventario"
  | "inventario_inicial"
  | "estorno"
  | "cancelamento_nf";

export interface Produto {
  id: string;
  sku: string;
  descricao: string;
  gtin: string | null;
  imagem_url: string | null;
  unidade: string;
  ncm: string | null;
  cest: string | null;
  origem_fiscal: number | null;
  sincronizado_em: string | null;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
}

export interface ProdutoEmpresa {
  produto_id: string;
  empresa_id: string;
  tiny_produto_id: number;
  ativo: boolean;
}

export interface Localizacao {
  id: string;
  galpao_id: string;
  codigo: string;
  descricao: string | null;
  tipo: TipoLocalizacao;
  ativo: boolean;
  criado_em: string;
}

export interface EstoqueLinha {
  id: string;
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  custo_medio: number;
  atualizado_em: string;
}

export interface Movimentacao {
  id: string;
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
  tipo: TipoMov;
  quantidade: number;
  saldo_anterior: number;
  saldo_posterior: number;
  reservado_anterior: number;
  reservado_posterior: number;
  origem_tipo: OrigemTipo;
  origem_id: string | null;
  origem_detalhes: Record<string, unknown>;
  emprestimo_devedora_id: string | null;
  expira_em: string | null;
  nota_fiscal_id: number | null;
  chave_acesso_nf: string | null;
  custo_unitario: number | null;
  usuario_id: string | null;
  observacoes: string | null;
  estorno_de: string | null;
  criado_em: string;
}

/**
 * Quádrupla — chave única que identifica uma posição de estoque.
 */
export interface Quadrupla {
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
}

export type PerspectivaEstoque = "dono" | "galpao" | "localizacao" | "produto";
