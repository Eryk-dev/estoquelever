/**
 * Tiny ERP API v3 client.
 * Wraps common operations used by the SISO webhook processor.
 */

const TINY_BASE = "https://api.tiny.com.br/public-api/v3";

interface TinyRequestOptions {
  token: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

const MAX_RETRIES = 3;

async function tinyFetch<T>(
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

    return res.json() as Promise<T>;
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
    formaEnvio?: {
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

/** Product detail (tipo + image + gtin) */
export interface TinyProdutoDetalhe {
  tipo: string; // K=Kit, S=Simples, V=Variacoes, F=Fabricado, M=MateriaPrima
  imagemUrl: string | null;
  gtin: string | null;
}

/** Fetch product detail — returns tipo, first image URL, and GTIN */
export async function getProdutoDetalhe(
  token: string,
  produtoId: number,
): Promise<TinyProdutoDetalhe> {
  const res = await tinyFetch<{
    tipo?: string;
    gtin?: string | null;
    anexos?: Array<{ url?: string | null }>;
  }>(`/produtos/${produtoId}`, { token });
  return {
    tipo: res.tipo ?? "S",
    imagemUrl: res.anexos?.[0]?.url ?? null,
    gtin: res.gtin || null,
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

/** Post stock from a nota fiscal */
export async function lancarEstoqueNota(
  token: string,
  notaId: number,
): Promise<void> {
  await tinyFetch<void>(`/notas/${notaId}/lancar-estoque`, {
    token,
    method: "POST",
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
