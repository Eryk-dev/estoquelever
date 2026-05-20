// Reflete schema 3D pós-simplificação (Fase 2 do plano
// docs/superpowers/plans/2026-05-20-ledger-simplificado-3d.md):
// estoque/movimentações são chaveados por (produto, galpão, localização).
// Custo médio vive em tabela separada (`siso_produto_custo_medio`).

export type TipoLocalizacao =
  | "picking"
  | "overstock"
  | "recebimento"
  | "expedicao"
  | "quarentena";

export type TipoMov = "E" | "S" | "R" | "L";

export type OrigemTipo =
  | "nf_compra"
  | "devolucao_cliente_integra"
  | "devolucao_cliente_avariada"
  | "devolucao_fornecedor_recebida"
  | "nf_venda"
  | "venda_manual"
  | "devolucao_fornecedor_enviada"
  | "ajuste_manual"
  | "ajuste_pick_zerou"
  | "inventario_perda"
  | "inventario_ganho"
  | "inventario_inicial"
  | "transferencia_galpao"
  | "transferencia_localizacao"
  | "reserva_pedido"
  | "liberacao_reserva"
  | "lancamento_retroativo"
  | "estorno";

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
  galpao_id: string;
  localizacao_id: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  atualizado_em: string;
}

export interface Movimentacao {
  id: string;
  produto_id: string;
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
  empresa_compradora_id?: string | null;
  empresa_vendedora_id?: string | null;
  empresa_referencia_id?: string | null;
  fornecedor_id?: string | null;
  motivo?: string | null;
  cliente_nome?: string | null;
  custo_unitario?: number | null;
  custo_medio_anterior?: number | null;
  custo_medio_posterior?: number | null;
  expira_em: string | null;
  pedido_id?: string | null;
  nota_fiscal_id?: string | null;
  chave_acesso_nf?: string | null;
  usuario_id: string | null;
  /** @deprecated use motivo. Column kept for historical reads only. */
  observacoes: string | null;
  estorno_de: string | null;
  criado_em: string;
}

/**
 * Tripla — chave única que identifica uma posição de estoque (3D).
 */
export interface Tripla {
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
}

export type PerspectivaEstoque = "galpao" | "localizacao" | "produto";

/**
 * Custo médio por produto (siso_produto_custo_medio).
 * Tabela separada do ledger — produto tem custo único e global.
 */
export interface CustoMedio {
  produto_id: string;
  custo_medio: number;
  ultima_movimentacao_id: string | null;
  atualizado_em: string;
}
