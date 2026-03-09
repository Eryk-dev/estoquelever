// ============================================================
// SISO - Sistema Inteligente de Separação de Ordens
// Types
// ============================================================

/** Filial origin */
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

/** Stock info for one product across both filials */
export interface EstoqueItem {
  produtoId: number;
  sku: string;
  descricao: string;
  quantidadePedida: number;
  /** Stock in CWB - depositos[1] on Tiny */
  estoqueCWB: DepositoEstoque | null;
  /** Stock in SP - depositos[0] on Tiny */
  estoqueSP: DepositoEstoque | null;
  /** Whether this specific item can be fulfilled by CWB */
  cwbAtende: boolean;
  /** Whether this specific item can be fulfilled by SP */
  spAtende: boolean;
  /** Supplier for OC based on SKU prefix */
  fornecedorOC: string | null;
  /** Physical location code in CWB warehouse (e.g., "A3-12") */
  localizacaoCWB?: string;
  /** Physical location code in SP warehouse (e.g., "SP-A2-08") */
  localizacaoSP?: string;
}

/** A complete order with stock enrichment */
export interface Pedido {
  id: string;
  numero: string;
  data: string;
  /** Which filial received the order (based on CNPJ) */
  filialOrigem: Filial;
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

/** Tab definition for the dashboard */
export interface Tab {
  id: "pendente" | "concluidos" | "auto";
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
