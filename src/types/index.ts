// ============================================================
// SISO - Sistema Inteligente de Separação de Ordens
// Types
// ============================================================

/** @deprecated Use galpaoId instead. Kept for backwards compatibility. */
export type Filial = "CWB" | "SP";

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

/** Stock info for one product across galpoes */
export interface EstoqueItem {
  produtoId: number;
  sku: string;
  descricao: string;
  quantidadePedida: number;
  /** Stock in CWB (aggregated across empresas in that galpao) */
  estoqueCWB: DepositoEstoque | null;
  /** Stock in SP (aggregated across empresas in that galpao) */
  estoqueSP: DepositoEstoque | null;
  /** Whether this item can be fulfilled by CWB galpao */
  cwbAtende: boolean;
  /** Whether this item can be fulfilled by SP galpao */
  spAtende: boolean;
  /** Supplier for OC based on SKU prefix */
  fornecedorOC: string | null;
  /** Physical location in CWB warehouse */
  localizacaoCWB?: string;
  /** Physical location in SP warehouse */
  localizacaoSP?: string;
  /** Product image URL (from Tiny anexos) */
  imagemUrl?: string;
}

/** A complete order with stock enrichment */
export interface Pedido {
  id: string;
  numero: string;
  data: string;
  /** Which galpao received the order (galpao name: "CWB", "SP", etc.) */
  filialOrigem: Filial;
  /** Empresa that received the order (UUID) */
  empresaOrigemId?: string;
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

// ─── Auth / Usuarios ────────────────────────────────────────────────────────

/** User role — determines what they see */
export type Cargo = "admin" | "operador_cwb" | "operador_sp" | "comprador";

export const CARGO_LABELS: Record<Cargo, string> = {
  admin: "Administrador",
  operador_cwb: "Operador CWB",
  operador_sp: "Operador SP",
  comprador: "Comprador",
};

export interface Usuario {
  id: string;
  nome: string;
  pin: string;
  cargo: Cargo;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
}

// ─── Galpao / Empresa / Grupo ───────────────────────────────────────────────

export interface Galpao {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
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
