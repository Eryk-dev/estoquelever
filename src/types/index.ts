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
  /** siso_pedido_itens row ID */
  itemId: string;
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
  /** Galpão name the order was forwarded from (manual encaminhar) */
  encaminhado_de?: string | null;
  /** Separation/packing flow status */
  status_separacao?: StatusSeparacao | null;
  /** Vendor (sales rep) responsible — manual orders or marketplace auto-assigned */
  vendedor_id?: string | null;
  vendedor_nome?: string | null;
  /** Order origin: 'webhook' (Tiny/marketplace) or 'manual' (inserted in /wms/vendas) */
  origem_pedido?: "webhook" | "manual";
  /** Sales channel for manual orders: Balcão | WhatsApp | Telefone | livre */
  canal_venda?: string | null;
}

/** Mode for manual order creation in /wms/vendas */
export type ModoVendaDireta = "separacao" | "baixa_direta";

/** Request shape for POST /api/wms/vendas/criar */
export interface CriarVendaDiretaRequest {
  cliente_nome: string;
  cliente_cpf_cnpj?: string | null;
  canal_venda?: string | null;
  empresa_origem_id: string;
  /** Galpão único onde a venda acontece (sobe pro top-level — vendedor está num balcão). */
  galpao_id: string;
  modo: ModoVendaDireta;
  items: Array<{
    produto_id: string;
    quantidade: number;
  }>;
  idempotency_key?: string;
  /**
   * Atribuir esta venda em nome de outro vendedor (opcional).
   *
   * Quando setado, o pedido grava vendedor_id/vendedor_nome do usuário-alvo
   * em vez do usuário da sessão. Requer permissão `vendas.criar_em_nome_de`
   * (admin/operador_*). Se igual ao user.id, é ignorado.
   */
  vendedor_id_alvo?: string;
}

/** Response shape for POST /api/wms/vendas/criar */
export interface CriarVendaDiretaResponse {
  pedido_id: string;
  numero: string;
  status: string;
  status_separacao: string | null;
  movs_criadas?: number;
  /** True se o vendedor pediu baixa_direta mas algum item sem saldo forçou ir pra separação. */
  degradado?: boolean;
  /** Motivo da degradação (quando degradado=true). */
  motivo_degradacao?: "falta_saldo";
  /** SKUs que ficaram sem saldo (quando degradado=true). */
  skus_sem_saldo?: string[];
  idempotente?: boolean;
}

// ─── Separacao / Embalagem ──────────────────────────────────────────────────

/** Status of the separation/packing flow */
export type StatusSeparacao =
  | "aguardando_compra"
  | "aguardando_nf"
  | "validacao_oc"
  | "aguardando_separacao"
  | "em_separacao"
  | "separado"
  | "embalado"
  | "pendente_realocacao";

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
  validacao_oc: number;
  aguardando_separacao: number;
  em_separacao: number;
  separado: number;
  embalado: number;
  pendente_realocacao: number;
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
  | "oc_pendente"
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

/** Item within a purchase order (OC) for the comprado tab card */
export interface CompraOcItem {
  id: string;
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade: number;
  compra_status: string | null;
  compra_quantidade_recebida: number;
  pedido_id: string;
  numero_pedido: string;
  aging_dias: number;
}

/** Item in the exceptions tab (indisponivel, equivalente_pendente, cancelamento_pendente) */
export interface CompraExceptionItem {
  id: string;
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade: number;
  aging_dias: number;
  prioridade: "critica" | "alta" | "normal";
  proxima_acao: string;
  fornecedor_oc: string | null;
  pedido_id: string;
  numero_pedido: string;
  empresa_nome: string | null;
  galpao_id: string | null;
  galpao_nome: string | null;
  compra_status: string | null;
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_equivalente_fornecedor: string | null;
  compra_equivalente_observacao: string | null;
  compra_cancelamento_motivo: string | null;
}

// ─── Inventário ─────────────────────────────────────────────────────────────

/** Inventory mode: location only or location + stock */
export type InventarioModo = "loc_only" | "loc_estoque";

/** Stock movement type: Balanço, Entrada, Saída */
export type TipoEstoque = "B" | "E" | "S";

/** Status of an inventory session */
export type InventarioStatus =
  | "em_andamento"
  | "processando"
  | "concluido"
  | "cancelado"
  | "erro"
  | "revertendo"
  | "revertido";

/** Status of an individual inventory item */
export type InventarioItemStatus = "pendente" | "processando" | "sucesso" | "erro";

/** An inventory session (siso_inventarios) */
export interface Inventario {
  id: string;
  empresa_id: string;
  galpao_id: string;
  usuario_id: string;
  deposito_id: number | null;
  modo: InventarioModo;
  tipo_estoque: TipoEstoque | null;
  manter_localizacao_antiga: boolean;
  status: InventarioStatus;
  observacoes: string | null;
  created_at: string;
  processado_em: string | null;
  concluido_em: string | null;
  /** Joined fields */
  empresa?: { nome: string };
  galpao?: { nome: string };
  usuario?: { nome: string };
  /** Computed counts */
  total_itens?: number;
  itens_sucesso?: number;
  itens_erro?: number;
}

/** A scanned item in an inventory session (siso_inventario_itens) */
export interface InventarioItem {
  id: string;
  inventario_id: string;
  produto_id_tiny: number | null;
  sku: string;
  nome_produto: string | null;
  ean: string | null;
  localizacao: string;
  quantidade: number;
  status: InventarioItemStatus;
  erro_msg: string | null;
  localizacao_antiga_tiny: string | null;
  saldo_anterior_tiny: number | null;
  created_at: string;
}

/** Consolidated view of inventory items grouped by SKU */
export interface InventarioItemConsolidado {
  sku: string;
  nome_produto: string | null;
  produto_id_tiny: number | null;
  ean: string | null;
  quantidade_total: number;
  localizacoes: string;
  itens_ids: string[];
  status: InventarioItemStatus;
  erro_msg: string | null;
}

// ─── Transferência ──────────────────────────────────────────────────────────

/** Status of a transfer session (same values as InventarioStatus) */
export type TransferenciaStatus =
  | "em_andamento"
  | "processando"
  | "concluido"
  | "cancelado"
  | "erro"
  | "revertendo"
  | "revertido";

/** A stock transfer session between empresas (siso_transferencias) */
export interface Transferencia {
  id: string;
  empresa_origem_id: string;
  empresa_destino_id: string;
  galpao_origem_id: string;
  galpao_destino_id: string;
  usuario_id: string;
  deposito_origem_id: number | null;
  deposito_destino_id: number | null;
  status: TransferenciaStatus;
  observacoes: string | null;
  created_at: string;
  processado_em: string | null;
  concluido_em: string | null;
  /** Joined fields */
  empresa_origem?: { nome: string };
  empresa_destino?: { nome: string };
  galpao_origem?: { nome: string };
  galpao_destino?: { nome: string };
  usuario?: { nome: string };
  /** Computed counts */
  total_itens?: number;
  itens_sucesso?: number;
  itens_erro?: number;
}

/** An item in a transfer session (siso_transferencia_itens) */
export interface TransferenciaItem {
  id: string;
  transferencia_id: string;
  produto_id_tiny_origem: number;
  produto_id_tiny_destino: number | null;
  sku: string;
  nome_produto: string | null;
  ean: string | null;
  quantidade: number;
  clonado: boolean;
  status: InventarioItemStatus;
  erro_msg: string | null;
  created_at: string;
}

// ─── Auth / Usuarios ────────────────────────────────────────────────────────

/**
 * Cargo legado — mantido por compat com `siso_usuarios.cargo`/`cargos[]`.
 * Substituído pelo modelo dinâmico de `Role` no novo RBAC. Strings
 * continuam aceitando as 6 originais como literals; código novo deve
 * usar `Role` + `userCan(session, "perm")` ao invés de checks por cargo.
 */
export type Cargo = "admin" | "operador" | "operador_cwb" | "operador_sp" | "comprador" | "vendedor";

export const CARGO_LABELS: Record<Cargo, string> = {
  admin: "Administrador",
  operador: "Operador",
  operador_cwb: "Operador CWB",
  operador_sp: "Operador SP",
  comprador: "Comprador",
  vendedor: "Vendedor",
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

// ── Roles & Permissões (dinâmico, vindo do DB) ──
export interface Role {
  id: string;
  codigo: string;          // 'admin', 'operador', 'conferente'
  nome: string;            // "Admin", "Conferente"
  descricao?: string | null;
  sistema: boolean;        // true = não pode deletar/renomear código
  ativo: boolean;
  criado_em?: string;
  atualizado_em?: string;
}

export interface RoleComContagens extends Role {
  n_permissoes: number;
  n_usuarios: number;
}

export interface RoleDetalhada extends Role {
  permissoes: string[];    // códigos
  usuarios: Array<{ id: string; nome: string; roles: string[] }>;
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
