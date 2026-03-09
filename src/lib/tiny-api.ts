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

async function tinyFetch<T>(
  path: string,
  { token, method = "GET", body }: TinyRequestOptions,
): Promise<T> {
  const url = `${TINY_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tiny API ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TinyPedidoItem {
  produto: {
    id: number;
    codigo: string; // SKU
    descricao: string;
  };
  quantidade: number;
  valorUnitario: number;
}

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
  depositos: TinyDeposito[];
}

export interface TinyProdutoBusca {
  id: number;
  codigo: string;
  descricao: string;
}

// ─── API calls ──────────────────────────────────────────────────────────────

/** Fetch full order details */
export async function getPedido(
  token: string,
  pedidoId: string,
): Promise<TinyPedidoDetalhe> {
  const res = await tinyFetch<{ data: TinyPedidoDetalhe }>(
    `/pedidos/${pedidoId}`,
    { token },
  );
  return res.data;
}

/** Fetch stock for a product */
export async function getEstoque(
  token: string,
  produtoId: number,
): Promise<TinyEstoque> {
  const res = await tinyFetch<{ data: TinyEstoque }>(
    `/estoque/${produtoId}`,
    { token },
  );
  return res.data;
}

/** Search product by SKU in a specific Tiny account */
export async function buscarProdutoPorSku(
  token: string,
  sku: string,
): Promise<TinyProdutoBusca | null> {
  const res = await tinyFetch<{ data: { itens: TinyProdutoBusca[] } }>(
    `/produtos?codigo=${encodeURIComponent(sku)}&situacao=A`,
    { token },
  );
  const itens = res.data?.itens ?? [];
  return itens.length > 0 ? itens[0] : null;
}

/** List all deposits (warehouses) from Tiny */
export async function listarDepositos(token: string): Promise<TinyDeposito[]> {
  const res = await tinyFetch<{ data: { itens: TinyDeposito[] } }>(
    "/depositos",
    { token },
  );
  return res.data?.itens ?? [];
}

/** Test connection by fetching company info */
export async function testarConexao(
  token: string,
): Promise<{ ok: boolean; nome?: string; erro?: string }> {
  try {
    const res = await tinyFetch<{ data: { razaoSocial?: string; nomeFantasia?: string } }>(
      "/info",
      { token },
    );
    return {
      ok: true,
      nome: res.data?.nomeFantasia ?? res.data?.razaoSocial ?? "Conectado",
    };
  } catch (err) {
    return {
      ok: false,
      erro: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}
