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
  | "venda_manual"
  | "nf_devolucao_cliente"
  | "nf_devolucao_avariada"
  | "nf_devolucao_fornecedor"
  | "transferencia_galpao"
  | "transferencia_localizacao"
  | "emprestimo"
  | "reserva_pedido"
  | "liberacao_reserva"
  | "ajuste_manual"
  | "inventario"
  | "inventario_inicial"
  | "estorno"
  | "cancelamento_nf"
  | "swap"
  | "ajuste_pick_zerou";

export interface Produto {
  id: string;
  sku: string;
  descricao: string;
  gtin: string | null;
  imagem_url: string | null;
  imagens: string[];
  unidade: string;
  ncm: string | null;
  cest: string | null;
  origem_fiscal: number | null;
  sincronizado_em: string | null;
  ativo: boolean;
  eh_kit: boolean;
  criado_em: string;
  atualizado_em: string;
}

export interface ProdutoKit {
  id: string;
  kit_produto_id: string;
  componente_produto_id: string;
  quantidade: number;
  criado_em: string;
}

/** Composição expandida (com dados do componente embutidos) — usado pela UI. */
export interface ProdutoKitComposicao extends ProdutoKit {
  componente: Pick<
    Produto,
    "id" | "sku" | "descricao" | "imagem_url" | "ativo"
  >;
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
  /** Override manual da zona. Quando NULL, sistema infere via
   *  `codigo.split("-")[0]` (mesma lógica do RPC wms_inventario_proxima_loc). */
  zona?: string | null;
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
