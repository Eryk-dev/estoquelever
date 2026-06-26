/**
 * Cliente da API do Mercado Livre.
 *
 * Sempre envia o token via header Authorization: Bearer (nunca query string,
 * conforme guideline de segurança ML). Faz auto-retry 1× em 401 — pedindo
 * refresh do token e tentando de novo.
 */
import { ML_API_BASE, getValidMlToken } from "./ml-oauth";
import { createServiceClient } from "./supabase-server";
import { extrairZplDeBuffer } from "./etiqueta-download";
import { logger } from "./logger";
import {
  isMlDisabled,
  getMlUserMeStub,
  searchSellerItemsBySkuStub,
  searchAndMatchItemsBySkuStub,
  getMlItemsDetailsStub,
  testarMlConnectionStub,
} from "./ml-stub";

// ─── Tipos ──────────────────────────────────────────────────────────

export interface MlUserMe {
  id: number;
  nickname: string;
  email?: string;
  site_id: string;
  user_type?: string;
}

export interface MlItemSearchResp {
  seller_id: string;
  paging: { limit: number; offset: number; total: number };
  results: string[]; // array de MLB ids
}

export interface MlAttribute {
  id: string;
  name?: string;
  value_name?: string | null;
  value_id?: string | null;
  values?: Array<{
    id?: string | null;
    name?: string | null;
    struct?: unknown;
  }>;
}

export interface MlVariation {
  id: number | string;
  seller_custom_field?: string | null;
  attributes?: MlAttribute[];
  attribute_combinations?: Array<{
    id: string;
    name?: string;
    value_name?: string | null;
  }>;
  available_quantity?: number;
  sold_quantity?: number;
  price?: number;
  picture_ids?: string[];
}

export interface MlItem {
  id: string;
  title: string;
  price: number;
  currency_id: string;
  status: string; // active | paused | closed | under_review | inactive | …
  permalink: string;
  available_quantity: number;
  sold_quantity?: number;
  thumbnail?: string;
  listing_type_id?: string;
  seller_custom_field?: string | null;
  attributes?: MlAttribute[];
  variations?: MlVariation[];
}

// ─── Fetch genérico com auto-refresh em 401 ─────────────────────────

async function mlFetch<T>(
  connectionId: string,
  path: string,
  init?: RequestInit & { retried?: boolean },
): Promise<T> {
  const token = await getValidMlToken(connectionId, {
    forceRefresh: init?.retried === true,
  });
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");

  const url = path.startsWith("http") ? path : `${ML_API_BASE}${path}`;
  const res = await fetch(url, { ...init, headers });

  // 401 → 1 retry passando forceRefresh pra getValidMlToken (que cuida do
  // single-flight + claim de lease). Não mexemos mais direto em expires_at
  // — isso criava refresh duplicado sob concorrência.
  if (res.status === 401 && !init?.retried) {
    logger.info("ml-api", "401 — forçando refresh + retry", {
      connectionId,
      path,
    });
    return mlFetch<T>(connectionId, path, { ...init, retried: true });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ML API ${res.status} ${path}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

// ─── Endpoints usados ───────────────────────────────────────────────

export async function getMlUserMe(connectionId: string): Promise<MlUserMe> {
  if (isMlDisabled()) {
    const s = await getMlUserMeStub(connectionId);
    // Bridge: MlUserMe requires site_id; stub doesn't carry it. Default MLB.
    return { ...s, site_id: "MLB" };
  }
  return mlFetch<MlUserMe>(connectionId, "/users/me");
}

/**
 * Busca anúncios por SKU usando os 2 caminhos suportados pelo ML:
 *   1. ?sku=… (seller_custom_field do item)
 *   2. ?seller_sku=… (atributo padronizado SELLER_SKU do item)
 *
 * Os dois endpoints buscam apenas no nível ITEM — não enxergam SKUs que
 * vivem só dentro de `variations[]`. Por isso o filtro final por SKU é
 * feito em `searchAndMatchItemsBySku()` aplicando match também nas
 * variações do item baixado.
 *
 * Pagina via offset até esgotar (limit=100/page, máx 1000 resultados —
 * limite do endpoint público do ML).
 */
export async function searchSellerItemsBySku(
  connectionId: string,
  sellerId: number,
  sku: string,
): Promise<string[]> {
  if (isMlDisabled()) {
    // Stub retorna { results: [], total: 0 } — flatten pra string[]
    // (contrato público da função real).
    const s = await searchSellerItemsBySkuStub(sku);
    return s.results;
  }
  const enc = encodeURIComponent(sku);
  const ids = new Set<string>();

  async function paginate(param: "sku" | "seller_sku"): Promise<void> {
    const LIMIT = 100;
    let offset = 0;
    while (offset < 1000) {
      let page: MlItemSearchResp;
      try {
        page = await mlFetch<MlItemSearchResp>(
          connectionId,
          `/users/${sellerId}/items/search?${param}=${enc}&limit=${LIMIT}&offset=${offset}`,
        );
      } catch (err) {
        logger.warn("ml-api", `search by ${param} falhou`, {
          connectionId,
          sku,
          offset,
          err: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      page.results.forEach((id) => ids.add(id));
      const total = page.paging?.total ?? 0;
      offset += LIMIT;
      if (offset >= total || page.results.length === 0) return;
    }
  }

  await Promise.all([paginate("sku"), paginate("seller_sku")]);
  return Array.from(ids);
}

// ─── SKU extraction helpers (espelho do Levercopy/item_copier.py) ───

function readSellerSkuFromAttrs(attrs?: MlAttribute[]): string | null {
  if (!attrs) return null;
  for (const a of attrs) {
    if (a.id !== "SELLER_SKU") continue;
    if (a.value_name && a.value_name.trim()) return a.value_name.trim();
    if (a.value_id && String(a.value_id).trim()) return String(a.value_id).trim();
    if (Array.isArray(a.values)) {
      for (const v of a.values) {
        if (v?.name && String(v.name).trim()) return String(v.name).trim();
        if (v?.id && String(v.id).trim()) return String(v.id).trim();
      }
    }
  }
  return null;
}

/**
 * Coleta TODOS os SKUs que aparecem num MlItem — top-level + variações.
 * Usado pra confirmar match no nível da aplicação, depois que o search
 * do ML devolveu o item.
 */
export function collectAllSkusFromItem(item: MlItem): string[] {
  const out = new Set<string>();
  if (item.seller_custom_field && item.seller_custom_field.trim()) {
    out.add(item.seller_custom_field.trim());
  }
  const top = readSellerSkuFromAttrs(item.attributes);
  if (top) out.add(top);
  for (const v of item.variations ?? []) {
    if (v.seller_custom_field && v.seller_custom_field.trim()) {
      out.add(v.seller_custom_field.trim());
    }
    const fromAttr = readSellerSkuFromAttrs(v.attributes);
    if (fromAttr) out.add(fromAttr);
  }
  return Array.from(out);
}

/**
 * Faz match case-insensitive de SKUs (trim aplicado).
 */
export function skusMatch(a: string, b: string): boolean {
  return a.trim().toLocaleUpperCase() === b.trim().toLocaleUpperCase();
}

/**
 * Pipeline completa: busca MLB ids por SKU, baixa detalhes (incluindo
 * variações) e filtra deixando só anúncios que TÊM o SKU buscado em
 * qualquer um dos 4 lugares onde o ML guarda SKU (item-top, item-attr,
 * variation-top, variation-attr).
 *
 * Isso fecha o gap do search nativo do ML, que não procura dentro de
 * `variations[]` — é o motivo principal de SKUs de variação sumirem
 * com o approach simples de 2 endpoints.
 */
export async function searchAndMatchItemsBySku(
  connectionId: string,
  sellerId: number,
  sku: string,
): Promise<MlItem[]> {
  if (isMlDisabled()) return searchAndMatchItemsBySkuStub(sku);
  const ids = await searchSellerItemsBySku(connectionId, sellerId, sku);
  if (ids.length === 0) return [];
  const items = await getMlItemsDetails(connectionId, ids);
  return items.filter((it) =>
    collectAllSkusFromItem(it).some((s) => skusMatch(s, sku)),
  );
}

/**
 * Multi-get de detalhes de items (até 20 por chamada).
 * Retorna lista deduplicada com campos essenciais pro UI do recebimento.
 */
export async function getMlItemsDetails(
  connectionId: string,
  itemIds: string[],
): Promise<MlItem[]> {
  if (isMlDisabled()) return getMlItemsDetailsStub(itemIds);
  if (itemIds.length === 0) return [];

  const out: MlItem[] = [];
  // ML aceita até 20 ids por multi-get
  for (let i = 0; i < itemIds.length; i += 20) {
    const slice = itemIds.slice(i, i + 20);
    const attributes =
      "id,title,price,currency_id,status,permalink,available_quantity," +
      "sold_quantity,thumbnail,listing_type_id,seller_custom_field,attributes," +
      "variations";
    const resp = await mlFetch<
      Array<{ code: number; body: MlItem }>
    >(
      connectionId,
      `/items?ids=${slice.join(",")}&attributes=${attributes}`,
    );
    resp.forEach((r) => {
      if (r.code === 200 && r.body) out.push(r.body);
    });
  }
  return out;
}

// ─── Prazo de despacho (SLA) por pedido ─────────────────────────────

interface MlOrderShippingRef {
  shipping?: { id?: number | null } | null;
}

interface MlShipmentSla {
  status?: string | null;
  /** Prazo LIMITE de despacho (ship-by), ISO8601 com offset. Ex.: "2026-06-16T16:00:00-03:00". */
  expected_date?: string | null;
  service?: string | null;
  last_updated?: string | null;
}

export interface MlShipmentSlaResult {
  shipmentId: number;
  /** Prazo limite de despacho (ISO8601) ou null se o envio não expõe SLA. */
  expectedDate: string | null;
  status: string | null;
}

/**
 * Resolve a conexão ML ATIVA vinculada a uma empresa (1:1 via empresa_id).
 * Retorna null se a empresa não tem conexão ML vinculada/ativa.
 */
export async function getActiveMlConnectionForEmpresa(
  empresaId: string,
): Promise<string | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_ml_connections")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Resolve o shipmentId de um pedido ML.
 *
 * O `id_pedido_ecommerce` que o Tiny envia pode ser um **order_id** OU um
 * **pack_id** (carrinho com vários itens). Por isso resolve dos dois jeitos:
 *   - GET /orders/{id}  → shipping.id           (pedido simples)
 *   - GET /packs/{id}   → shipment.id           (carrinho; /orders dá 404)
 * Retorna null se o pedido não tem shipment (ex.: retirada na loja).
 */
async function resolverShipmentId(
  connectionId: string,
  orderId: string,
): Promise<number | null> {
  let shipmentId: number | null | undefined;
  try {
    const order = await mlFetch<MlOrderShippingRef>(
      connectionId,
      `/orders/${orderId}`,
    );
    shipmentId = order.shipping?.id;
  } catch {
    // /orders dá 404 quando o id é um pack_id (carrinho) — tenta /packs.
    try {
      const pack = await mlFetch<{ shipment?: { id?: number | null } | null }>(
        connectionId,
        `/packs/${orderId}`,
      );
      shipmentId = pack.shipment?.id;
    } catch (err) {
      logger.info("ml-api", "id não resolve como order nem pack", {
        connectionId,
        orderId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return shipmentId ?? null;
}

/**
 * Busca o prazo de despacho (SLA) de um pedido ML.
 *
 * O `id_pedido_ecommerce` que o Tiny envia pode ser um **order_id** OU um
 * **pack_id** (carrinho com vários itens). Por isso resolve o shipment dos
 * dois jeitos:
 *   - GET /orders/{id}  → shipping.id           (pedido simples)
 *   - GET /packs/{id}   → shipment.id           (carrinho; /orders dá 404)
 * Depois: GET /shipments/{id}/sla → expected_date (hora LIMITE de despacho,
 * mais preciso que o `dataEnvio` do Tiny, que traz só o dia). Retorna null
 * se não houver shipment ou se o envio não expõe SLA (não é erro fatal).
 */
export async function getMlShipmentSla(
  connectionId: string,
  orderId: string,
): Promise<MlShipmentSlaResult | null> {
  if (isMlDisabled()) return null;

  const shipmentId = await resolverShipmentId(connectionId, orderId);
  if (!shipmentId) return null;

  let expectedDate: string | null = null;
  let status: string | null = null;
  try {
    const sla = await mlFetch<MlShipmentSla>(
      connectionId,
      `/shipments/${shipmentId}/sla`,
    );
    expectedDate = sla.expected_date ?? null;
    status = sla.status ?? null;
  } catch (err) {
    // 404/sem-SLA é esperado p/ alguns fretes — degrada sem quebrar.
    logger.info("ml-api", "shipment sem SLA disponível", {
      connectionId,
      shipmentId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return { shipmentId, expectedDate, status };
}

// ─── Substatus do shipment (Separação Futura) ───────────────────────

interface MlShipmentDetail {
  status?: string | null;
  /** `buffered` = etiqueta segurada p/ data futura; `ready_to_print` = liberada. */
  substatus?: string | null;
}

export interface MlShipmentStatusResult {
  shipmentId: number;
  status: string | null;
  substatus: string | null;
}

/**
 * Lê o `substatus` do shipment ML — sinal autoritativo de "etiqueta segurada
 * (buffered) vs liberada (ready_to_print)". O endpoint /sla NÃO carrega
 * `substatus`, por isso busca o objeto shipment direto (GET /shipments/{id}).
 * Reusa a resolução de shipmentId (order/pack). Retorna null se não há shipment.
 */
export async function getMlShipmentStatus(
  connectionId: string,
  orderId: string,
): Promise<MlShipmentStatusResult | null> {
  if (isMlDisabled()) return null;

  const shipmentId = await resolverShipmentId(connectionId, orderId);
  if (!shipmentId) return null;

  try {
    const sh = await mlFetch<MlShipmentDetail>(
      connectionId,
      `/shipments/${shipmentId}`,
    );
    return {
      shipmentId,
      status: sh.status ?? null,
      substatus: sh.substatus ?? null,
    };
  } catch (err) {
    logger.info("ml-api", "falha ao ler shipment detail (substatus)", {
      connectionId,
      shipmentId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Lê status + substatus de um shipment DIRETO pelo shipmentId (sem resolver
 * order/pack). Usado pelo webhook de notificações do ML, que já entrega o
 * shipment_id no `resource`. Retorna null se ML desabilitado ou shipment
 * inacessível.
 */
export async function getMlShipmentStatusById(
  connectionId: string,
  shipmentId: number | string,
): Promise<{ status: string | null; substatus: string | null } | null> {
  if (isMlDisabled()) return null;
  try {
    const sh = await mlFetch<MlShipmentDetail>(
      connectionId,
      `/shipments/${shipmentId}`,
    );
    return { status: sh.status ?? null, substatus: sh.substatus ?? null };
  } catch (err) {
    logger.info("ml-api", "falha ao ler shipment detail by id", {
      connectionId,
      shipmentId: String(shipmentId),
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Etiqueta de envio direto do ML (NF já expedida no Tiny) ─────────

export interface MlEtiquetaZplResult {
  zpl: string;
  shipmentId: number;
  trackingNumber: string | null;
}

/**
 * Baixa a etiqueta de envio (ZPL) direto do Mercado Livre.
 *
 * Necessário quando o ML/Tiny já marcou a NF como "expedida" (vendas Mercado
 * Envios geram a etiqueta no ML e a integração ML↔Tiny expede a NF sozinha) —
 * aí `criarAgrupamento` no Tiny falha com "já foi expedida" e o ZPL nunca fica
 * sob um agrupamento que o SISO conheça. O ML expõe o mesmo ZIP que o Tiny
 * ("Etiqueta de envio.txt" + "Controle.pdf"), então reusamos o extrator.
 *
 * GET /shipment_labels?shipment_ids={id}&response_type=zpl2 → ZIP (binário), por
 * isso NÃO passa pelo mlFetch (JSON-only) — fetch direto com Bearer.
 * Retorna null quando ML está desabilitado, não há shipment, ou o download falha.
 */
export async function obterEtiquetaZplShipment(
  connectionId: string,
  orderId: string,
): Promise<MlEtiquetaZplResult | null> {
  if (isMlDisabled()) return null;

  const shipmentId = await resolverShipmentId(connectionId, orderId);
  if (!shipmentId) return null;

  // Tracking (best-effort) só pra semear os barcodes da conferência.
  let trackingNumber: string | null = null;
  try {
    const sh = await mlFetch<{ tracking_number?: string | null }>(
      connectionId,
      `/shipments/${shipmentId}`,
    );
    trackingNumber = sh.tracking_number ?? null;
  } catch {
    /* non-fatal */
  }

  const token = await getValidMlToken(connectionId);
  const url = `${ML_API_BASE}/shipment_labels?shipment_ids=${shipmentId}&response_type=zpl2`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    logger.warn("ml-api", "falha ao baixar etiqueta ZPL do shipment", {
      connectionId,
      shipmentId: String(shipmentId),
      status: String(res.status),
    });
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const zpl = await extrairZplDeBuffer(buffer, `ml-shipment-${shipmentId}`);
  if (!zpl) return null;

  return { zpl, shipmentId, trackingNumber };
}

// ─── Test connection ────────────────────────────────────────────────

export async function testarMlConnection(
  connectionId: string,
): Promise<{ ok: boolean; nickname?: string; erro?: string }> {
  if (isMlDisabled()) {
    const s = await testarMlConnectionStub();
    return { ok: s.ok, nickname: s.nickname };
  }
  try {
    const me = await getMlUserMe(connectionId);
    return { ok: true, nickname: me.nickname };
  } catch (err) {
    return { ok: false, erro: err instanceof Error ? err.message : String(err) };
  }
}
