/**
 * Tiny ERP API v3 client.
 * Wraps common operations used by the SISO webhook processor.
 *
 * Rate limiting: When called within a runWithEmpresa() scope (from tiny-queue.ts),
 * all requests are automatically queued and rate-limited per empresa
 * (55 req/min, max 5 concurrent). The 429 retry loop below acts as
 * a defense-in-depth fallback.
 */

import { getContextEmpresaId, tinyQueue } from "./tiny-queue";
import { isTinyDisabled, tinyStubResponse } from "./tiny-stub";

const TINY_BASE = "https://api.tiny.com.br/public-api/v3";

interface TinyRequestOptions {
  token: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

const MAX_RETRIES = 3;

/**
 * Main entry point for Tiny API calls.
 *
 * When TINY_DISABLED=true, routes to the local stub (tiny-stub.ts) which
 * reads/writes against staging Supabase tables instead of api.tiny.com.br.
 *
 * Otherwise routes through the in-memory queue when an empresa context is set
 * (via runWithEmpresa), or calls directly.
 */
async function tinyFetch<T>(
  path: string,
  opts: TinyRequestOptions,
): Promise<T> {
  if (isTinyDisabled()) {
    return tinyStubResponse<T>(path, opts.method ?? "GET", opts.body);
  }

  const empresaId = getContextEmpresaId();

  if (empresaId) {
    return tinyQueue.execute(empresaId, () => doTinyFetch<T>(path, opts));
  }

  return doTinyFetch<T>(path, opts);
}

/** Raw HTTP fetch with 429 retry (defense-in-depth). */
async function doTinyFetch<T>(
  path: string,
  { token, method = "GET", body }: TinyRequestOptions,
): Promise<T> {
  const url = `${TINY_BASE}${path}`;
  const jsonBody = body ? JSON.stringify(body) : undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: jsonBody,
    });

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Tiny API ${method} ${path} → 429 after ${MAX_RETRIES} retries`);
      }
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 30_000)
        : Math.min(2000 * 2 ** attempt, 15_000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tiny API ${method} ${path} → ${res.status}: ${text}`);
    }

    if (res.status === 204) {
      return undefined as unknown as T;
    }

    const text = await res.text();
    if (!text) {
      return undefined as unknown as T;
    }

    return JSON.parse(text) as T;
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`Tiny API ${method} ${path} → exhausted retries`);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TinyPedidoItem {
  produto: {
    id: number;
    sku: string; // SKU (API v3 field name)
    descricao: string;
  };
  quantidade: number;
  valorUnitario: number;
}

/** Raw Tiny API v3 response for GET /pedidos/{id} */
interface TinyPedidoRaw {
  id: number;
  numeroPedido: number;
  data: string; // "2024-01-01"
  dataEnvio?: string | null;
  dataPrevista?: string | null;
  cliente: {
    id: number;
    nome: string;
    cpfCnpj?: string;
  };
  ecommerce?: {
    id: number;
    nome: string;
    numeroPedidoEcommerce: string;
  };
  transportador?: {
    id?: number;
    formaEnvio?: {
      id: number;
      nome: string;
    };
    formaFrete?: {
      id: number;
      nome: string;
    };
  };
  itens: TinyPedidoItem[];
}

/** Normalized pedido detail (used by webhook-processor) */
export interface TinyPedidoDetalhe {
  id: string;
  numero: string;
  data: string;
  dataEnvio?: string | null;
  idPedidoEcommerce?: string;
  nomeEcommerce?: string;
  cliente: {
    nome: string;
    cpfCnpj?: string;
  };
  formaEnvio?: {
    id: string;
    descricao: string;
  };
  formaFrete?: {
    id: string;
    descricao: string;
  };
  transportadorId?: string;
  itens: TinyPedidoItem[];
}

export interface TinyDeposito {
  id: number;
  nome: string;
  saldo: number;
  reservado?: number;
}

export interface TinyEstoque {
  localizacao?: string | null;
  depositos: TinyDeposito[];
}

export interface TinyProdutoBusca {
  id: number;
  codigo: string;
  descricao: string;
}

// ─── API calls ──────────────────────────────────────────────────────────────

/** Item returned by GET /pedidos (list) */
export interface TinyPedidoListItem {
  id: number;
  numeroPedido: number;
  data: string;
  situacao: string;
  ecommerce?: {
    id: number;
    nome: string;
    numeroPedidoEcommerce: string;
  };
  cliente?: {
    id: number;
    nome: string;
  };
}

/**
 * List orders with optional filters.
 * Per spec (api tiny.json): dataInicial/dataFinal filtram por data de CRIAÇÃO
 * do pedido; dataAtualizacao filtra por data de ATUALIZAÇÃO (formato
 * YYYY-MM-DD); situacao é o código numérico (3=Aprovada, 2=Cancelada).
 */
export async function listarPedidos(
  token: string,
  params: {
    situacao?: string | number;
    dataInicial?: string;
    dataFinal?: string;
    dataAtualizacao?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ itens: TinyPedidoListItem[]; paginacao?: { total?: number }; total?: number }> {
  const query = new URLSearchParams();
  if (params.situacao != null) query.set("situacao", String(params.situacao));
  if (params.dataInicial) query.set("dataInicial", params.dataInicial);
  if (params.dataFinal) query.set("dataFinal", params.dataFinal);
  if (params.dataAtualizacao) query.set("dataAtualizacao", params.dataAtualizacao);
  query.set("limit", String(params.limit ?? 100));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return tinyFetch<{ itens: TinyPedidoListItem[]; paginacao?: { total?: number }; total?: number }>(
    `/pedidos${qs ? `?${qs}` : ""}`,
    { token },
  );
}

/** Item returned by GET /notas (list) — fields from BaseNotaFiscalModel */
export interface TinyNotaListItem {
  id: number;
  situacao?: number | string;
  tipo?: "E" | "S";
  numero?: string;
  serie?: string;
  chaveAcesso?: string;
  dataEmissao?: string;
  valor?: number;
}

/**
 * List invoices with optional filters.
 * Per spec: dataInicial/dataFinal filtram por data de criação (YYYY-MM-DD);
 * situacao é código numérico (6=Autorizada, 7=Emitida Danfe).
 */
export async function listarNotas(
  token: string,
  params: {
    situacao?: string | number;
    tipo?: "E" | "S";
    dataInicial?: string;
    dataFinal?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ itens: TinyNotaListItem[]; paginacao?: { total?: number } }> {
  const query = new URLSearchParams();
  if (params.situacao != null) query.set("situacao", String(params.situacao));
  if (params.tipo) query.set("tipo", params.tipo);
  if (params.dataInicial) query.set("dataInicial", params.dataInicial);
  if (params.dataFinal) query.set("dataFinal", params.dataFinal);
  query.set("limit", String(params.limit ?? 100));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return tinyFetch<{ itens: TinyNotaListItem[]; paginacao?: { total?: number } }>(
    `/notas${qs ? `?${qs}` : ""}`,
    { token },
  );
}

/** Fetch full order details (maps API v3 field names to normalized shape) */
export async function getPedido(
  token: string,
  pedidoId: string,
): Promise<TinyPedidoDetalhe> {
  const raw = await tinyFetch<TinyPedidoRaw>(`/pedidos/${pedidoId}`, { token });
  return {
    id: String(raw.id),
    numero: String(raw.numeroPedido),
    data: raw.data,
    dataEnvio: raw.dataEnvio || raw.dataPrevista || null,
    idPedidoEcommerce: raw.ecommerce?.numeroPedidoEcommerce ?? undefined,
    nomeEcommerce: raw.ecommerce?.nome ?? undefined,
    cliente: {
      nome: raw.cliente?.nome ?? "Desconhecido",
      cpfCnpj: raw.cliente?.cpfCnpj,
    },
    formaEnvio: raw.transportador?.formaEnvio
      ? {
          id: String(raw.transportador.formaEnvio.id),
          descricao: raw.transportador.formaEnvio.nome,
        }
      : undefined,
    formaFrete: raw.transportador?.formaFrete
      ? {
          id: String(raw.transportador.formaFrete.id),
          descricao: raw.transportador.formaFrete.nome,
        }
      : undefined,
    transportadorId: raw.transportador?.id ? String(raw.transportador.id) : undefined,
    itens: raw.itens ?? [],
  };
}

/** Fetch stock for a product */
export async function getEstoque(
  token: string,
  produtoId: number,
): Promise<TinyEstoque> {
  return tinyFetch<TinyEstoque>(`/estoque/${produtoId}`, { token });
}

/** Product detail (tipo + images + gtin + descricaoComplementar) */
export interface TinyProdutoDetalhe {
  tipo: string; // K=Kit, S=Simples, V=Variacoes, F=Fabricado, M=MateriaPrima
  imagens: string[];
  /** imagens[0] ou null. Mantido pro consumidor que só quer a capa. */
  imagemUrl: string | null;
  gtin: string | null;
  descricaoComplementar: string | null;
}

/** Fetch product detail — returns tipo, all image URLs, GTIN, and complementary description (where OEM codes typically live) */
export async function getProdutoDetalhe(
  token: string,
  produtoId: number,
): Promise<TinyProdutoDetalhe> {
  const res = await tinyFetch<{
    tipo?: string;
    gtin?: string | null;
    descricaoComplementar?: string | null;
    anexos?: Array<{ url?: string | null }>;
  }>(`/produtos/${produtoId}`, { token });
  const imagens = (res.anexos ?? [])
    .map((a) => a.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  return {
    tipo: res.tipo ?? "S",
    imagens,
    imagemUrl: imagens[0] ?? null,
    gtin: res.gtin || null,
    descricaoComplementar: res.descricaoComplementar ?? null,
  };
}

/** Fornecedor info embutida no detalhe do produto. */
export interface TinyProdutoFornecedor {
  id: number;
  nome: string;
  codigoProdutoNoFornecedor: string | null;
}

/** Componente embutido no detalhe do produto (somente se tipo='K'). */
export interface TinyProdutoKitItem {
  produto: { id: number; sku: string | null; descricao: string | null };
  quantidade: number;
}

/**
 * Union de getProdutoCompleto + getProdutoDetalhe + fornecedores + kit numa
 * única chamada HTTP. Evita pagar 2x o /produtos/{id} no backfill em massa.
 */
export interface TinyProdutoFull extends TinyProdutoCompleto {
  tipo: string;
  imagens: string[];
  imagemUrl: string | null;
  descricaoComplementar: string | null;
  fornecedores: TinyProdutoFornecedor[];
  kit: TinyProdutoKitItem[];
}

export async function getProdutoFull(
  token: string,
  produtoId: number,
): Promise<TinyProdutoFull> {
  const res = await tinyFetch<{
    id: number;
    descricao?: string;
    sku?: string;
    tipo?: string;
    gtin?: string | null;
    unidade?: string;
    ncm?: string;
    origem?: number | null;
    precos?: { preco?: number; precoCusto?: number } | null;
    descricaoComplementar?: string | null;
    anexos?: Array<{ url?: string | null }>;
    fornecedores?: Array<{
      id?: number;
      nome?: string | null;
      codigoProdutoNoFornecedor?: string | null;
    }>;
    kit?: Array<{
      produto?: {
        id?: number;
        sku?: string | null;
        descricao?: string | null;
      };
      quantidade?: number;
    }>;
  }>(`/produtos/${produtoId}`, { token });

  const imagens = (res.anexos ?? [])
    .map((a) => a.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  const fornecedores: TinyProdutoFornecedor[] = (res.fornecedores ?? [])
    .filter((f) => f.id != null && f.nome)
    .map((f) => ({
      id: f.id as number,
      nome: f.nome as string,
      codigoProdutoNoFornecedor: f.codigoProdutoNoFornecedor ?? null,
    }));

  const kit: TinyProdutoKitItem[] = (res.kit ?? [])
    .filter((k) => k.produto?.id != null && k.quantidade != null)
    .map((k) => ({
      produto: {
        id: k.produto!.id as number,
        sku: k.produto!.sku ?? null,
        descricao: k.produto!.descricao ?? null,
      },
      quantidade: k.quantidade as number,
    }));

  return {
    id: res.id,
    descricao: res.descricao ?? "",
    sku: res.sku ?? "",
    precos: res.precos ?? null,
    gtin: res.gtin || null,
    unidade: res.unidade,
    ncm: res.ncm,
    origem: res.origem ?? null,
    tipo: res.tipo ?? "S",
    imagens,
    imagemUrl: imagens[0] ?? null,
    descricaoComplementar: res.descricaoComplementar ?? null,
    fornecedores,
    kit,
  };
}

/** Kit component from GET /produtos/{id}/kit */
export interface TinyKitComponente {
  produto: {
    id: number;
    sku: string | null;
    descricao: string | null;
  };
  quantidade: number;
}

/** Fetch kit components for a product */
export async function getProdutoKit(
  token: string,
  produtoId: number,
): Promise<TinyKitComponente[]> {
  return tinyFetch<TinyKitComponente[]>(`/produtos/${produtoId}/kit`, { token });
}

/** Search product by SKU in a specific Tiny account */
export async function buscarProdutoPorSku(
  token: string,
  sku: string,
): Promise<TinyProdutoBusca | null> {
  const res = await tinyFetch<{ itens: TinyProdutoBusca[] }>(
    `/produtos?codigo=${encodeURIComponent(sku)}&situacao=A`,
    { token },
  );
  const itens = res.itens ?? [];
  return itens.length > 0 ? itens[0] : null;
}

/** Search product by GTIN (EAN barcode) in a specific Tiny account */
export async function buscarProdutoPorGtin(
  token: string,
  gtin: string,
): Promise<TinyProdutoBusca | null> {
  const res = await tinyFetch<{ itens: TinyProdutoBusca[] }>(
    `/produtos?gtin=${encodeURIComponent(gtin)}&situacao=A`,
    { token },
  );
  const itens = res.itens ?? [];
  return itens.length > 0 ? itens[0] : null;
}

/** Product data for cloning between empresas (from GET /produtos/{id}) */
export interface TinyProdutoCompleto {
  id: number;
  descricao: string;
  sku: string;
  precos?: { preco?: number; precoCusto?: number } | null;
  gtin?: string | null;
  unidade?: string;
  ncm?: string;
  origem?: number | null;
}

/** Fetch full product detail for cloning purposes */
export async function getProdutoCompleto(
  token: string,
  produtoId: number,
): Promise<TinyProdutoCompleto> {
  return tinyFetch<TinyProdutoCompleto>(`/produtos/${produtoId}`, { token });
}

/** Fields for creating a new product in Tiny (maps to CriarProdutoRequestModel) */
export interface TinyProdutoCriacao {
  descricao: string;
  tipo?: string;
  sku: string;
  preco?: number;
  gtin?: string;
  ncm?: string;
  unidade?: string;
  origem?: number;
}

/** Create a new product in Tiny — maps fields to API v3 schema */
export async function criarProduto(
  token: string,
  dados: TinyProdutoCriacao,
): Promise<{ id: number }> {
  return tinyFetch<{ id: number }>("/produtos", {
    token,
    method: "POST",
    body: {
      descricao: dados.descricao,
      tipo: dados.tipo ?? "S",
      sku: dados.sku,
      precos: dados.preco != null ? { preco: dados.preco } : undefined,
      gtin: dados.gtin,
      ncm: dados.ncm,
      unidade: dados.unidade,
      origem: dados.origem,
    },
  });
}

/** List all deposits (warehouses) from Tiny by fetching stock of any active product */
export async function listarDepositos(token: string): Promise<TinyDeposito[]> {
  // Tiny v3 has no /depositos endpoint — deposits come from stock queries.
  // Fetch first active product, then get its stock to discover deposits.
  const prodRes = await tinyFetch<{ itens: { id: number }[] }>(
    "/produtos?situacao=A&limit=1",
    { token },
  );
  const firstProduct = prodRes.itens?.[0];
  if (!firstProduct) return [];

  const stockRes = await tinyFetch<{ depositos: TinyDeposito[] }>(
    `/estoque/${firstProduct.id}`,
    { token },
  );
  return stockRes.depositos ?? [];
}

/** Post (deduct) stock for an order — calls the origin account */
export async function lancarEstoque(
  token: string,
  pedidoId: string,
): Promise<void> {
  await tinyFetch<unknown>(`/pedidos/${pedidoId}/lancar-estoque`, {
    token,
    method: "POST",
  });
}

/** Reverse a previous stock posting */
export async function estornarEstoque(
  token: string,
  pedidoId: string,
): Promise<void> {
  await tinyFetch<unknown>(`/pedidos/${pedidoId}/estornar-estoque`, {
    token,
    method: "POST",
  });
}

/** Update order status in Tiny */
export async function atualizarStatusPedido(
  token: string,
  pedidoId: string,
  situacao: "aberto" | "aprovado" | "preparando" | "faturado" | "pronto" | "enviado" | "entregue" | "cancelado",
): Promise<void> {
  await tinyFetch<unknown>(`/pedidos/${pedidoId}/situacao`, {
    token,
    method: "PUT",
    body: { situacao },
  });
}

/** Move stock for a single product (entry, exit, or balance) */
export async function movimentarEstoque(
  token: string,
  produtoId: number,
  params: {
    tipo: "E" | "S" | "B";
    quantidade: number;
    deposito?: { id: number };
    observacoes?: string;
    precoUnitario?: number;
  },
): Promise<{ idLancamento: number }> {
  return tinyFetch<{ idLancamento: number }>(`/estoque/${produtoId}`, {
    token,
    method: "POST",
    body: {
      tipo: params.tipo,
      quantidade: params.quantidade,
      precoUnitario: params.precoUnitario ?? 0,
      ...(params.deposito && { deposito: params.deposito }),
      ...(params.observacoes && { observacoes: params.observacoes }),
    },
  });
}

// ─── Nota Fiscal (obter) ─────────────────────────────────────────────────────

/** Raw response from GET /notas/{idNota} — only fields we need */
export interface TinyNotaFiscal {
  id: number;
  numero?: string | null;
  serie?: string | null;
  chaveAcesso?: string | null;
  dataEmissao?: string | null;
  valor?: number | null;
  situacao?: number | null;
  origem?: {
    id: string | null;
    tipo: string | null; // "venda" | "pedido_compra" | "notafiscal" | "ordemservico" | "cobranca" | "devolucao"
  };
}

/** Fetch invoice details by ID */
export async function obterNotaFiscal(
  token: string,
  notaId: number,
): Promise<TinyNotaFiscal> {
  return tinyFetch<TinyNotaFiscal>(`/notas/${notaId}`, { token });
}

// ─── Marcadores + Nota Fiscal ────────────────────────────────────────────────

/** Create marcadores on a Tiny order */
export async function criarMarcadoresPedido(
  token: string,
  pedidoId: string,
  marcadores: string[],
): Promise<void> {
  const body = marcadores.map((m) => ({ descricao: m }));
  await tinyFetch<void>(`/pedidos/${pedidoId}/marcadores`, {
    token,
    method: "POST",
    body,
  });
}

/** Generate NF from an order */
export interface NotaFiscalGerada {
  id: number;
  numero: number;
  serie: number;
}

export async function gerarNotaFiscal(
  token: string,
  pedidoId: string,
  modelo: number = 55,
): Promise<NotaFiscalGerada> {
  return tinyFetch<NotaFiscalGerada>(`/pedidos/${pedidoId}/gerar-nota-fiscal`, {
    token,
    method: "POST",
    body: { modelo },
  });
}

// ─── Expedição (Shipment Groups + Labels) ───────────────────────────────────

/** Response from POST /expedicao */
export interface TinyCriarAgrupamentoResponse {
  id: number;
}

/** Response from GET /expedicao/{idAgrupamento}/etiquetas */
export interface TinyEtiquetasAgrupamentoResponse {
  urls: string[];
}

/** Create a shipment group (agrupamento de expedição) from NF IDs + forma de frete. */
export async function criarAgrupamento(
  token: string,
  idsNotasFiscais: number[],
  formaFreteId?: number,
): Promise<TinyCriarAgrupamentoResponse> {
  const body: Record<string, unknown> = { idsNotasFiscais };
  if (formaFreteId) {
    body.logistica = { formaFrete: { id: formaFreteId } };
  }
  return tinyFetch<TinyCriarAgrupamentoResponse>("/expedicao", {
    token,
    method: "POST",
    body,
  });
}

/** Complete (concluir) a shipment group so labels become available */
export async function concluirAgrupamento(
  token: string,
  idAgrupamento: number,
): Promise<void> {
  await tinyFetch<void>(`/expedicao/${idAgrupamento}/concluir`, {
    token,
    method: "POST",
  });
}

/** Fetch label URLs for a shipment group (all expeditions) */
export async function obterEtiquetasAgrupamento(
  token: string,
  idAgrupamento: number,
): Promise<TinyEtiquetasAgrupamentoResponse> {
  return tinyFetch<TinyEtiquetasAgrupamentoResponse>(
    `/expedicao/${idAgrupamento}/etiquetas`,
    { token },
  );
}

/** Response from GET /expedicao/{idAgrupamento} */
export interface TinyExpedicaoResponse {
  id: number;
  tipoObjeto: string;
  idObjeto: number;
  situacao: string;
  venda?: {
    id: number;
    numero?: number;
  };
  /** LogisticaExpedicaoResponseModel — codigoRastreio é o barcode da etiqueta (Shopee raster só tem ele) */
  logistica?: {
    codigoRastreio?: string | null;
    urlRastreio?: string | null;
  };
}

export interface TinyAgrupamentoResponse {
  id: number;
  identificacao: string;
  expedicoes: TinyExpedicaoResponse[];
}

/** Get agrupamento details including expeditions list */
export async function obterAgrupamento(
  token: string,
  idAgrupamento: number,
): Promise<TinyAgrupamentoResponse> {
  return tinyFetch<TinyAgrupamentoResponse>(
    `/expedicao/${idAgrupamento}`,
    { token },
  );
}

/** Fetch label URLs for a specific expedition within an agrupamento */
export async function obterEtiquetasExpedicao(
  token: string,
  idAgrupamento: number,
  idExpedicao: number,
): Promise<TinyEtiquetasAgrupamentoResponse> {
  return tinyFetch<TinyEtiquetasAgrupamentoResponse>(
    `/expedicao/${idAgrupamento}/expedicao/${idExpedicao}/etiquetas`,
    { token },
  );
}

/** Update product location in Tiny */
export async function atualizarLocalizacaoProduto(
  token: string,
  produtoId: number,
  localizacao: string,
): Promise<void> {
  // PUT /produtos/{id} requires descricao + sku — fetch them first
  const produto = await tinyFetch<{ descricao: string; sku: string }>(
    `/produtos/${produtoId}`,
    { token },
  );

  await tinyFetch<void>(`/produtos/${produtoId}`, {
    token,
    method: "PUT",
    body: {
      descricao: produto.descricao,
      sku: produto.sku,
      estoque: { localizacao },
    },
  });
}

/** Test connection by fetching company info */
export async function testarConexao(
  token: string,
): Promise<{ ok: boolean; nome?: string; erro?: string }> {
  try {
    const res = await tinyFetch<{ razaoSocial?: string; fantasia?: string }>(
      "/info",
      { token },
    );
    return {
      ok: true,
      nome: res.fantasia ?? res.razaoSocial ?? "Conectado",
    };
  } catch (err) {
    return {
      ok: false,
      erro: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}
