/**
 * Tiny ERP API stub layer (staging-only).
 *
 * When TINY_DISABLED=true, every call from `tinyFetch` (tiny-api.ts) is
 * routed here instead of hitting api.tiny.com.br. Reads return data shaped
 * exactly like the real Tiny API, sourced from local staging tables:
 *   - GET /pedidos/{id}            → siso_stub_pedidos
 *   - GET /pedidos?...             → siso_stub_pedidos
 *   - GET /estoque/{produtoId}     → aggregated siso_estoque
 *   - GET /produtos/{id}           → siso_produtos + siso_produto_empresas
 *   - GET /produtos?codigo=X       → siso_produtos
 *   - GET /produtos/{id}/kit       → empty (kits not seeded yet)
 *   - GET /notas/{id}              → derived from siso_pedidos.nota_fiscal_id
 *
 * Writes return deterministic fake IDs and DO NOT mutate any local state.
 * The cutover code (Onda 3+) writes directly to siso_estoque/siso_movimentacoes
 * via WMS RPCs, so the stub responses for `lancarEstoque`/`movimentarEstoque`
 * are intentional no-ops.
 *
 * Fake ID strategy: deterministic from input (hash-free, just arithmetic on
 * the pedidoId/produtoId) so retries/idempotency keys stay stable across runs.
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";

// ─── Flag ──────────────────────────────────────────────────────────────────

export function isTinyDisabled(): boolean {
  return process.env.TINY_DISABLED === "true";
}

// ─── Deterministic fake-id helpers ─────────────────────────────────────────

/** Produces a stable numeric ID derived from a string input. */
function fakeIdFrom(input: string, salt: number = 0): number {
  let h = 5381 + salt;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 90_000_000 + 10_000_000;
}

/** Fake 44-char chave_acesso NF (matches regex /^\d{44}$/). */
function fakeChaveAcesso(notaId: number): string {
  const seed = String(notaId);
  let result = seed;
  while (result.length < 44) {
    result += String(fakeIdFrom(result, result.length));
  }
  return result.slice(0, 44);
}

// ─── Path parsing ──────────────────────────────────────────────────────────

interface ParsedPath {
  segments: string[];
  query: URLSearchParams;
}

function parsePath(rawPath: string): ParsedPath {
  const [pathPart, queryPart] = rawPath.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart ?? "");
  return { segments, query };
}

// ─── Main dispatch ─────────────────────────────────────────────────────────

export async function tinyStubResponse<T>(
  rawPath: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body: unknown,
): Promise<T> {
  const { segments, query } = parsePath(rawPath);
  const [resource, id, action, subResource, subId, subAction] = segments;

  logger.info("tiny.stub", `${method} ${rawPath}`, {
    resource,
    action,
    bodyKeys: body && typeof body === "object" ? Object.keys(body) : undefined,
  });

  // ─── Pedidos ────────────────────────────────────────────────────────────
  if (resource === "pedidos") {
    if (method === "GET" && !id) {
      return handleListPedidos<T>(query);
    }
    if (method === "GET" && id && !action) {
      return handleGetPedido<T>(id);
    }
    if (method === "POST" && id && action === "marcadores") {
      return undefined as unknown as T; // no-op
    }
    if (method === "POST" && id && action === "gerar-nota-fiscal") {
      return handleGerarNotaFiscal<T>(id);
    }
    if (method === "POST" && id && action === "lancar-estoque") {
      return undefined as unknown as T;
    }
    if (method === "POST" && id && action === "estornar-estoque") {
      return undefined as unknown as T;
    }
    if (method === "PUT" && id && action === "situacao") {
      return undefined as unknown as T;
    }
    return notImplemented(method, rawPath);
  }

  // ─── Estoque ────────────────────────────────────────────────────────────
  if (resource === "estoque" && id) {
    if (method === "GET") {
      return handleGetEstoque<T>(id);
    }
    if (method === "POST") {
      // movimentarEstoque → fake idLancamento
      return { idLancamento: fakeIdFrom(`mov-${id}-${Date.now()}`) } as T;
    }
    return notImplemented(method, rawPath);
  }

  // ─── Produtos ──────────────────────────────────────────────────────────
  if (resource === "produtos") {
    if (method === "GET" && !id) {
      return handleListProdutos<T>(query);
    }
    if (method === "GET" && id && !action) {
      return handleGetProduto<T>(id);
    }
    if (method === "GET" && id && action === "kit") {
      return [] as unknown as T;
    }
    if (method === "POST" && !id) {
      // criarProduto → fake id
      return { id: fakeIdFrom(JSON.stringify(body)) } as T;
    }
    if (method === "PUT" && id) {
      return undefined as unknown as T;
    }
    return notImplemented(method, rawPath);
  }

  // ─── Notas (NF) ────────────────────────────────────────────────────────
  if (resource === "notas" && id) {
    if (method === "GET" && !action) {
      return handleGetNota<T>(id);
    }
    if (method === "POST" && action === "lancar-estoque") {
      return undefined as unknown as T;
    }
    return notImplemented(method, rawPath);
  }

  // ─── Expedição (shipment groups + labels) ──────────────────────────────
  if (resource === "expedicao") {
    if (method === "POST" && !id) {
      // criarAgrupamento
      const idsNotas = (body as { idsNotasFiscais?: number[] })?.idsNotasFiscais ?? [];
      return { id: fakeIdFrom(`agrup-${idsNotas.join("-")}`) } as T;
    }
    if (method === "POST" && id && action === "concluir") {
      return undefined as unknown as T;
    }
    if (method === "GET" && id && !action) {
      return {
        id: parseInt(id, 10),
        identificacao: `AGRUP-STAGING-${id}`,
        expedicoes: [
          {
            id: fakeIdFrom(`exp-${id}`),
            tipoObjeto: "venda",
            idObjeto: 0,
            situacao: "concluido",
          },
        ],
      } as T;
    }
    if (method === "GET" && id && action === "etiquetas") {
      return { urls: [`https://staging.local/etiqueta-fake-${id}.pdf`] } as T;
    }
    if (
      method === "GET" &&
      id &&
      action === "expedicao" &&
      subResource &&
      subAction === "etiquetas"
    ) {
      return { urls: [`https://staging.local/etiqueta-fake-${id}-${subResource}.zpl`] } as T;
    }
    return notImplemented(method, rawPath);
  }

  // ─── Info ──────────────────────────────────────────────────────────────
  if (resource === "info" && method === "GET") {
    return {
      razaoSocial: "STAGING — Tiny stubbed",
      fantasia: "STAGING",
    } as T;
  }

  return notImplemented(method, rawPath);
}

function notImplemented<T>(method: string, path: string): T {
  logger.warn("tiny.stub", `Unhandled stub path — returning undefined`, { method, path });
  return undefined as unknown as T;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleListPedidos<T>(query: URLSearchParams): Promise<T> {
  const supabase = createServiceClient();
  const limit = parseInt(query.get("limit") ?? "100", 10);
  const offset = parseInt(query.get("offset") ?? "0", 10);
  const situacao = query.get("situacao");

  let q = supabase
    .from("siso_stub_pedidos")
    .select("id, payload")
    .order("criado_em", { ascending: false })
    .range(offset, offset + limit - 1);

  if (situacao) {
    // best-effort: maps to nothing in stub payload; skip filter
  }

  const { data } = await q;
  const itens = (data ?? []).map((row) => row.payload);
  return { itens, total: itens.length } as T;
}

async function handleGetPedido<T>(pedidoId: string): Promise<T> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_stub_pedidos")
    .select("payload")
    .eq("id", pedidoId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`Tiny stub: pedido ${pedidoId} não encontrado em siso_stub_pedidos`);
  }
  return data.payload as T;
}

/**
 * Lookup product by Tiny ID. We resolve via siso_produto_empresas (tiny_produto_id → produto_id)
 * and project the Tiny-shape from siso_produtos.
 */
async function handleGetProduto<T>(produtoIdTiny: string): Promise<T> {
  const supabase = createServiceClient();
  const tinyIdNum = parseInt(produtoIdTiny, 10);

  // Resolve via mapping
  const { data: mapping } = await supabase
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("tiny_produto_id", tinyIdNum)
    .limit(1)
    .maybeSingle();

  let produto: { id?: string; sku?: string; descricao?: string; gtin?: string | null; unidade?: string; ncm?: string; imagem_url?: string | null } | null = null;

  if (mapping?.produto_id) {
    const { data } = await supabase
      .from("siso_produtos")
      .select("id, sku, descricao, gtin, unidade, ncm, imagem_url")
      .eq("id", mapping.produto_id)
      .maybeSingle();
    produto = data;
  }

  if (!produto) {
    // Last-resort fallback so callers don't crash; mark unknown.
    return {
      id: tinyIdNum,
      descricao: `[stub-unknown ${produtoIdTiny}]`,
      sku: "",
      tipo: "S",
      gtin: null,
      anexos: [],
    } as T;
  }

  return {
    id: tinyIdNum,
    descricao: produto.descricao ?? "",
    sku: produto.sku ?? "",
    tipo: "S", // stub doesn't model kits yet
    gtin: produto.gtin ?? null,
    unidade: produto.unidade ?? "UN",
    ncm: produto.ncm ?? "",
    origem: null,
    precos: { preco: 0, precoCusto: 0 },
    descricaoComplementar: null,
    anexos: produto.imagem_url ? [{ url: produto.imagem_url }] : [],
    fornecedores: [],
    kit: [],
  } as T;
}

async function handleListProdutos<T>(query: URLSearchParams): Promise<T> {
  const supabase = createServiceClient();
  const codigo = query.get("codigo");
  const gtin = query.get("gtin");
  const limit = parseInt(query.get("limit") ?? "1", 10);

  let q = supabase.from("siso_produtos").select("id, sku, descricao").limit(limit);

  if (codigo) {
    q = q.eq("sku", codigo);
  } else if (gtin) {
    q = q.eq("gtin", gtin);
  }

  const { data } = await q;
  if (!data || data.length === 0) {
    return { itens: [] } as T;
  }

  // Map siso_produtos UUIDs to Tiny IDs via siso_produto_empresas (first available).
  const produtoIds = data.map((p) => p.id);
  const { data: mappings } = await supabase
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .in("produto_id", produtoIds);

  const tinyByProduto = new Map<string, number>();
  for (const m of mappings ?? []) {
    if (!tinyByProduto.has(m.produto_id)) {
      tinyByProduto.set(m.produto_id, m.tiny_produto_id);
    }
  }

  const itens = data
    .map((p) => ({
      id: tinyByProduto.get(p.id) ?? fakeIdFrom(p.id),
      codigo: p.sku,
      descricao: p.descricao,
    }))
    .filter((p) => p.id != null);

  return { itens } as T;
}

/**
 * Aggregate siso_estoque rows for a given tiny_produto_id and return them
 * shaped as a TinyEstoque with one synthetic deposito per (empresa, galpão)
 * combo. Deposito IDs come from siso_tiny_connections so the caller's
 * pickDeposito(depositos, configured_deposito_id) logic still works.
 *
 * Paridade com Tiny real: cada conta Tiny vê **só seu depósito
 * configurado** (= galpão preferido da empresa). O stub agora filtra
 * `siso_estoque` pelos `siso_empresa_galpoes_preferenciais` da empresa
 * resolvida pelo mapping. Empresa sem preferenciais (raro mas possível —
 * ex: Bellator) retorna saldo zero, espelhando o caso real "empresa sem
 * depósito configurado".
 */
async function handleGetEstoque<T>(produtoIdTiny: string): Promise<T> {
  const supabase = createServiceClient();
  const tinyIdNum = parseInt(produtoIdTiny, 10);

  // Resolve produto + empresa via mapping
  const { data: mapping } = await supabase
    .from("siso_produto_empresas")
    .select("produto_id, empresa_id")
    .eq("tiny_produto_id", tinyIdNum)
    .maybeSingle();

  if (!mapping) {
    return { localizacao: null, depositos: [] } as T;
  }

  // Get configured deposito_id for this empresa so pickDeposito matches
  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("empresa_id", mapping.empresa_id)
    .eq("ativo", true)
    .maybeSingle();

  const depositoId = conn?.deposito_id ?? fakeIdFrom(`dep-${mapping.empresa_id}`);

  // Galpões preferenciais da empresa (espelha "depósito configurado" no
  // Tiny real — cada conta só enxerga o saldo do seu galpão).
  const { data: prefs } = await supabase
    .from("siso_empresa_galpoes_preferenciais")
    .select("galpao_id")
    .eq("empresa_id", mapping.empresa_id);

  const galpaoIds = (prefs ?? []).map((p) => p.galpao_id as string);

  if (galpaoIds.length === 0) {
    // Empresa sem depósito configurado — Tiny real não encontraria
    // saldo pra essa conta. Devolvemos zero pra espelhar.
    return {
      localizacao: null,
      depositos: [
        {
          id: depositoId,
          nome: "STAGING-DEPOSITO",
          saldo: 0,
          reservado: 0,
        },
      ],
    } as T;
  }

  // Aggregate saldo + reservado apenas nas linhas dos galpões preferidos.
  const { data: linhas } = await supabase
    .from("siso_estoque")
    .select("saldo, reservado, localizacao_id, siso_localizacoes(codigo)")
    .eq("produto_id", mapping.produto_id)
    .in("galpao_id", galpaoIds);

  let totalSaldo = 0;
  let totalReservado = 0;
  let primeiraLocalizacao: string | null = null;
  for (const linha of (linhas ?? []) as Array<{
    saldo: number | null;
    reservado: number | null;
    siso_localizacoes?: { codigo?: string | null } | null;
  }>) {
    totalSaldo += Number(linha.saldo ?? 0);
    totalReservado += Number(linha.reservado ?? 0);
    if (!primeiraLocalizacao && linha.siso_localizacoes?.codigo) {
      primeiraLocalizacao = linha.siso_localizacoes.codigo;
    }
  }

  return {
    localizacao: primeiraLocalizacao,
    depositos: [
      {
        id: depositoId,
        nome: "STAGING-DEPOSITO",
        saldo: totalSaldo,
        reservado: totalReservado,
      },
    ],
  } as T;
}

async function handleGerarNotaFiscal<T>(pedidoId: string): Promise<T> {
  const notaId = fakeIdFrom(`nf-${pedidoId}`);
  return {
    id: notaId,
    numero: notaId % 1_000_000,
    serie: 1,
  } as T;
}

async function handleGetNota<T>(notaIdStr: string): Promise<T> {
  const notaId = parseInt(notaIdStr, 10);
  const chave = fakeChaveAcesso(notaId);
  // origem ID can't be recovered from the notaId alone; the stub returns a
  // placeholder. Webhook reconciliation in processWebhook does its own match
  // via siso_pedidos.nota_fiscal_id, not via origem.id.
  return {
    id: notaId,
    numero: String(notaId % 1_000_000),
    serie: "1",
    chaveAcesso: chave,
    dataEmissao: new Date().toISOString(),
    valor: 0,
    situacao: 6, // Autorizada
    origem: { id: null, tipo: "venda" },
  } as T;
}
