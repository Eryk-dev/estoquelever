// ============================================================
// SISO - Sistema Inteligente de Separação de Ordens
// Types
// ============================================================

/** Possible decision for an order */
export type Decisao = "propria" | "transferencia" | "oc";

/** Status of order processing */
export type StatusPedido =
  | "pendente"
  | "executando"
  | "concluido"
  | "cancelado"
  | "erro";

/** How the order was resolved */
export type TipoResolucao = "auto" | "manual";

/** Stock info for a single deposit */
export interface DepositoEstoque {
  id: number;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
}

/** Stock info for one galpão (aggregated across empresas in that galpão) */
export interface GalpaoEstoque {
  deposito: DepositoEstoque;
  atende: boolean;
  localizacao?: string;
}

/** Stock info for one product across galpões */
export interface EstoqueItem {
  produtoId: number;
  sku: string;
  descricao: string;
  quantidadePedida: number;
  /** Stock per galpão — key is galpão name (e.g. "CWB", "SP") */
  estoques: Record<string, GalpaoEstoque>;
  /** Supplier for OC based on SKU prefix */
  fornecedorOC: string | null;
  /** Product image URL (from Tiny anexos) */
  imagemUrl?: string;
}

/** A complete order with stock enrichment */
export interface Pedido {
  id: string;
  numero: string;
  data: string;
  /** Which galpao received the order (galpao name, e.g. "CWB", "SP") */
  filialOrigem: string;
  /** Empresa that received the order (UUID) */
  empresaOrigemId?: string;
  /** Empresa name (e.g. "NetAir") */
  empresaOrigemNome?: string;
  /** E-commerce order ID */
  idPedidoEcommerce: string;
  /** E-commerce name (Mercado Livre, Shopee, etc) */
  nomeEcommerce: string;
  cliente: {
    nome: string;
    cpfCnpj: string;
  };
  formaEnvio: {
    id: string;
    descricao: string;
  };
  itens: EstoqueItem[];
  /** System suggestion */
  sugestao: Decisao;
  /** Explanation of the suggestion */
  sugestaoMotivo: string;
  /** Current status */
  status: StatusPedido;
  /** How it was resolved */
  tipoResolucao?: TipoResolucao;
  /** Decision taken by operator */
  decisaoFinal?: Decisao;
  /** Operator who processed */
  operador?: string;
  /** When it was processed */
  processadoEm?: string;
  /** Markers applied */
  marcadores?: string[];
  /** Error message if any */
  erro?: string;
  /** Created at */
  criadoEm: string;
  /** Separation operator UUID */
  separacao_operador_id?: string | null;
  /** When separation started */
  separacao_iniciada_em?: string | null;
  /** When separation completed */
  separacao_concluida_em?: string | null;
  /** When packing completed */
  embalagem_concluida_em?: string | null;
  /** Shipping label URL */
  etiqueta_url?: string | null;
  /** Expedition grouping ID */
  agrupamento_expedicao_id?: string | null;
  /** Alert: stock was already entered in Tiny before cancellation */
  compra_estoque_lancado_alerta?: boolean;
}

// ─── Separacao / Embalagem ──────────────────────────────────────────────────

/** Status of the separation/packing flow */
export type StatusSeparacao =
  | "aguardando_compra"
  | "aguardando_nf"
  | "aguardando_separacao"
  | "em_separacao"
  | "separado"
  | "embalado"
  | "cancelado";

/** Consolidated product for wave picking */
export interface ProdutoConsolidado {
  produto_id: string;
  descricao: string;
  sku: string;
  gtin: string | null;
  quantidade_total: number;
  unidade: string;
  localizacao: string | null;
}

/** Result of a barcode scan during packing */
export interface BipEmbalagemResult {
  pedido_id: string;
  produto_id: string;
  quantidade_bipada: number;
  bipado_completo: boolean;
  pedido_completo: boolean;
}

/** Filter params for the separation list API */
export interface SeparacaoFilter {
  status_separacao?: StatusSeparacao;
  empresa_origem_id?: string;
  sort?: "data_pedido" | "localizacao" | "sku";
  busca?: string;
}

/** Count of orders per separation status */
export interface SeparacaoCounts {
  aguardando_compra: number;
  aguardando_nf: number;
  aguardando_separacao: number;
  em_separacao: number;
  separado: number;
  embalado: number;
}

/** A row from siso_pedido_itens */
export interface PedidoItem {
  id: string;
  pedido_id: string;
  produto_id: string;
  sku: string;
  descricao: string;
  quantidade: number;
  quantidade_pedida: number;
  gtin: string | null;
  quantidade_bipada: number;
  bipado_completo: boolean;
  separacao_marcado: boolean;
  separacao_marcado_em: string | null;
  /** Tiny product ID for direct stock API calls */
  produto_id_tiny: number | null;
  /** Supplier for OC based on SKU prefix */
  fornecedor_oc: string | null;
  /** Linked purchase order ID */
  ordem_compra_id: string | null;
  /** Purchase status of this item */
  compra_status: CompraStatus;
  /** Quantity effectively requested for purchase */
  compra_quantidade_solicitada: number;
  /** Quantity already received */
  compra_quantidade_recebida: number;
  /** When the item entered the purchase flow */
  compra_solicitada_em: string | null;
  /** When the item was purchased */
  comprado_em: string | null;
  /** Who purchased it */
  comprado_por: string | null;
  /** When the item was received */
  recebido_em: string | null;
  /** Who received it */
  recebido_por: string | null;
}

/** Observation/comment on an order */
export interface Observacao {
  id: string;
  pedidoId: string;
  usuarioId: string;
  usuarioNome: string;
  texto: string;
  criadoEm: string;
}

/** Tab definition for tab bars */
export interface Tab {
  id: string;
  label: string;
  count: number;
}

// ─── Compras (Ordens de Compra) ─────────────────────────────────────────────

/** Status of a purchase order */
export type OrdemCompraStatus =
  | "aguardando_compra"
  | "comprado"
  | "parcialmente_recebido"
  | "recebido"
  | "cancelado";

/** Status of an individual item in the purchase flow */
export type CompraStatus =
  | "aguardando_compra"
  | "comprado"
  | "recebido"
  | "indisponivel"
  | "equivalente_pendente"
  | "cancelamento_pendente"
  | "cancelado"
  | null;

/** A purchase order (OC) for a specific supplier */
export interface OrdemCompra {
  id: string;
  fornecedor: string;
  empresa_id: string | null;
  galpao_id: string | null;
  status: OrdemCompraStatus;
  observacao: string | null;
  comprado_por: string | null;
  comprado_em: string | null;
  created_at: string;
}

/** Consolidated item for the Aguardando Compra view (grouped by SKU + fornecedor) */
export interface CompraItemAgrupado {
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade_total: number;
  pedidos_bloqueados: number;
  aging_dias: number;
  primeira_solicitacao_em: string | null;
  fornecedor_oc: string;
  em_rascunho?: boolean;
  pedidos: Array<{
    pedido_id: string;
    numero_pedido: string;
    quantidade: number;
  }>;
  itens_ids: string[];
}

/** Item for the conferencia (receiving) screen */
export interface ConferenciaItem {
  item_id: string;
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade_esperada: number;
  quantidade_ja_recebida: number;
  quantidade_restante: number;
  produto_id_tiny: number | null;
  pedidos: Array<{
    pedido_id: string;
    numero_pedido: string;
    quantidade: number;
  }>;
}

// ─── Auth / Usuarios ────────────────────────────────────────────────────────

/** User role — determines what they see */
export type Cargo = "admin" | "operador" | "operador_cwb" | "operador_sp" | "comprador";

export const CARGO_LABELS: Record<Cargo, string> = {
  admin: "Administrador",
  operador: "Operador",
  operador_cwb: "Operador CWB",
  operador_sp: "Operador SP",
  comprador: "Comprador",
};

/** Lightweight galpão reference for user context */
export interface UserGalpao {
  id: string;
  nome: string;
}

export interface Usuario {
  id: string;
  nome: string;
  pin: string;
  cargo: Cargo;
  cargos: Cargo[];
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
  printnode_printer_id: number | null;
  printnode_printer_nome: string | null;
}

/** Check if a user has a specific cargo */
export function userHasCargo(cargos: Cargo[], check: Cargo): boolean {
  return cargos.includes(check);
}

/** Check if any of the user's cargos is in a list */
export function userHasAnyCargo(cargos: Cargo[], allowed: string[]): boolean {
  return cargos.some((c) => allowed.includes(c));
}

// ─── Galpao / Empresa / Grupo ───────────────────────────────────────────────

export interface Galpao {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  printnode_printer_id: number | null;
  printnode_printer_nome: string | null;
}

export interface Empresa {
  id: string;
  nome: string;
  cnpj: string;
  galpaoId: string;
  ativo: boolean;
  grupoId: string | null;
  grupoNome: string | null;
  tier: number | null;
}

export interface Grupo {
  id: string;
  nome: string;
  descricao: string | null;
  empresas: Array<{
    empresaId: string;
    empresaNome: string;
    tier: number;
  }>;
}
