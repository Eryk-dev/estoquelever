import type { SupabaseClient } from "@supabase/supabase-js";

export interface StagingFixtures {
  empresas: {
    netair: { id: string; nome: string; cnpj: string; galpao_id: string };
    netparts: { id: string; nome: string; cnpj: string; galpao_id: string };
  };
  galpoes: {
    cwb: { id: string; nome: "CWB"; recebimento_loc_id: string };
    sp: { id: string; nome: "SP"; recebimento_loc_id: string };
  };
}

export interface HttpClient {
  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  delete<T = unknown>(path: string, headers?: Record<string, string>): Promise<T>;
}

export type Ctx = {
  sb: SupabaseClient;
  http: HttpClient;
  staging: StagingFixtures;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  skuUnico: (prefix: string) => string;
  correlationId: string;

  // setup helpers (DB direto)
  criarProduto: (p: { sku: string; descricao: string; gtin?: string }) => Promise<string>;
  criarLocalizacao: (p: { galpao: "CWB" | "SP"; codigo: string; tipo?: "picking" | "overstock" | "quarentena" | "expedicao" }) => Promise<string>;
  criarFornecedor: (p: { nome: string; prefixo_sku?: string }) => Promise<string>;
  semearSaldo: (p: { produto: string; galpao: "CWB" | "SP"; loc: string; qty: number; custo?: number }) => Promise<void>;

  // utilitário de tempo real
  aguardar: (ms: number) => Promise<void>;

  // ── pedido + separação ──
  webhook: (p: {
    empresa: string;
    items: { sku: string; qty: number }[];
    tipo?: "pedido" | "nota_fiscal";
    pedidoFakeId?: number;
  }) => Promise<{ id: string }>;
  aprovar: (pedidoId: string, decisao?: "propria" | "transferencia" | "oc") => Promise<void>;
  iniciarSeparacao: (pedidoId: string) => Promise<void>;
  bipar: (p: { pedido: string; item: string; qty: number; loc?: string }) => Promise<void>;
  parcial: (p: { pedido: string; item: string; qty: number; loc_zerou: boolean }) => Promise<void>;
  desfazerParcial: (p: { pedido: string; item: string }) => Promise<void>;
  encaminhar: (p: { pedido: string; item: string; galpao_destino: "CWB" | "SP" }) => Promise<void>;
  concluirSeparacao: (pedidoId: string) => Promise<void>;
  embalar: (pedidoId: string) => Promise<void>;
  expedir: (pedidoId: string) => Promise<void>;

  // ── waits ──
  aguardarStatus: (pedidoId: string, status: string, expected?: { decisao?: string }, opts?: { timeout_ms?: number }) => Promise<void>;
  aguardarStatusSeparacao: (pedidoId: string, status: string, opts?: { timeout_ms?: number }) => Promise<void>;
  aguardarRealocacao: (pedidoId: string, sku: string, locEsperada: string, opts?: { timeout_ms?: number }) => Promise<void>;
  aguardarFilaVazia: (opts?: { timeout_ms?: number }) => Promise<void>;

  // ── compras + recebimento ──
  comprar: (p: { sku: string; qty: number; fornecedor?: string; pedido_id?: string }) => Promise<{ ordem_id: string }>;
  receberCompra: (p: { ordem_id: string; items: { sku: string; qty: number }[] }) => Promise<void>;
  prepararEmbalagem: (p: { pedido_id: string }) => Promise<void>;
  receber: (p: { items: { sku: string; qty: number; loc_destino?: string }[]; galpao: "CWB" | "SP"; entrada_direta?: boolean }) => Promise<{ pendencias: string[] }>;
  guardar: (p: { pendencia_id: string; loc_destino: string; qty?: number }) => Promise<void>;
  desfazerGuarda: (p: { pendencia_id: string; motivo?: string }) => Promise<{ movsEstornadas: number }>;
  aguardarPendenciaGuarda: (pendenciaId: string, status: "pendente" | "em_guarda" | "guardada", opts?: { timeout_ms?: number }) => Promise<void>;

  // ── movs operacionais ──
  transferirGalpao: (p: { origem: "CWB" | "SP"; destino: "CWB" | "SP"; items: { sku: string; qty: number }[] }) => Promise<{ id: string }>;
  replenishment: (p: { sku: string; galpao: "CWB" | "SP"; origem_loc: string; destino_loc: string; qty: number }) => Promise<void>;
  ajusteManual: (p: { sku: string; galpao: "CWB" | "SP"; loc: string; delta: number; motivo: string }) => Promise<void>;
  lancamentoRetroativo: (p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; tipo: "E" | "S" }) => Promise<{ id: string }>;
  reconciliarRetroativo: (id: string) => Promise<void>;

  // ── vendas ──
  criarVendaDireta: (p: {
    galpao: "CWB" | "SP";
    empresa: "netair" | "netparts";
    items: { sku: string; qty: number }[];
    modo: "separacao" | "baixa_direta";
  }) => Promise<{ id: string; degradado: boolean; motivo_degradacao?: string; skus_sem_saldo?: string[] }>;
  disponibilidadeVenda: (p: { sku: string; galpao: "CWB" | "SP"; empresa: "netair" | "netparts" }) => Promise<{ localizacao_id?: string; disponivel: number }>;

  // ── reservas ──
  reservar: (p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; ttl_horas?: number; ttl_segundos?: number }) => Promise<{ mov_id: string }>;
  cleanupReservas: () => Promise<{ liberadas: number }>;

  // ── devoluções ──
  classificarDevolucao: (p: { devolucao_id: string; classificacao: "A" | "B" | "C" | "D" }) => Promise<void>;
  desclassificarDevolucao: (p: { devolucao_id: string; motivo?: string }) => Promise<{ movsEstornadas: number }>;

  // ── inventário ──
  criarSessaoInventario: (p: { galpao: "CWB" | "SP"; locs: string[]; modo?: "blind" | "aberto"; tipo?: "cycle_count" | "completo" }) => Promise<{ id: string }>;
  entrarParty: (sessaoId: string) => Promise<void>;
  proximaLoc: (sessaoId: string) => Promise<{ localizacao_id: string | null; pool_vazio?: boolean }>;
  bipeInventario: (p: { sessao_id: string; sku: string; loc: string; qty: number }) => Promise<void>;
  finalizarLocInventario: (p: { sessao_id: string; loc: string }) => Promise<void>;
  aprovarInventario: (sessaoId: string) => Promise<void>;
  aplicarInventario: (sessaoId: string) => Promise<void>;
  estornarInventario: (sessaoId: string, motivo?: string) => Promise<{ ok: boolean; movsEstornadas: number }>;

  // ── asserts ──
  assertSaldo: (sku: string, galpao: "CWB" | "SP", loc: string, qty_esperada: number) => Promise<void>;
  assertReservado: (sku: string, galpao: "CWB" | "SP", loc: string, qty_esperada: number) => Promise<void>;
  assertMovsCount: (sku: string, count_esperado: number) => Promise<void>;
  assertPedidoStatus: (pedidoId: string, status_esperado: string) => Promise<void>;
  assertCustoMedio: (sku: string, custo_esperado: number, tolerancia?: number) => Promise<void>;
  assertSemReservasOrfas: () => Promise<void>;
};

export interface Cenario<TSetup = unknown> {
  nome: string;
  descricao: string;
  tags: string[];
  setup: (ctx: Ctx) => Promise<TSetup>;
  run: (ctx: Ctx, setup: TSetup) => Promise<void>;
  assertEsperado: (ctx: Ctx, setup: TSetup) => Promise<void>;
  skip?: boolean;
  apenasSe?: () => boolean;
}

export interface InvariantResult {
  nome: string;
  ok: boolean;
  detalhes?: unknown;
  duracao_ms: number;
}

export interface ScenarioResult {
  nome: string;
  status: "pass" | "fail" | "skip";
  duracao_ms?: number;
  motivo?: "assert" | "invariante" | "timeout" | "setup" | "run";
  erro?: { mensagem: string; stack?: string };
  invariantes?: InvariantResult[];
  detalhes?: unknown;
  correlation_id?: string;
  logs?: unknown[];
}
