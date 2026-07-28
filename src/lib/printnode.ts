/**
 * PrintNode API client for server-side label printing.
 *
 * - testarConexao: validates API key via GET /whoami
 * - listarImpressoras: lists available printers via GET /printers
 * - enviarImpressao: sends a PDF print job via POST /printjobs (10s timeout, 1 retry)
 * - enviarImpressaoZpl: sends raw ZPL content via POST /printjobs (raw_base64)
 * - resolverImpressora: resolves printer for a user/galpao (user override > galpao default)
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import {
  isPrintNodeDisabled,
  enviarImpressaoStub,
  enviarImpressaoZplStub,
  testarConexaoStub,
  listarImpressorasStub,
} from "./printnode-stub";

const PRINTNODE_BASE = "https://api.printnode.com";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PrintNodePrinter {
  id: number;
  name: string;
  computer: string;
  state: string;
}

interface PrintNodeWhoamiResponse {
  id: number;
  email: string;
  [key: string]: unknown;
}

interface PrintNodePrinterRaw {
  id: number;
  name: string;
  computer: { id: number; name: string };
  state: string;
  [key: string]: unknown;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function getAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(apiKey + ":").toString("base64");
}

async function printNodeFetch<T>(
  apiKey: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${PRINTNODE_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: getAuthHeader(apiKey),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PrintNode ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Test PrintNode connection by calling GET /whoami.
 */
export async function testarConexao(
  apiKey: string,
): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (isPrintNodeDisabled()) return testarConexaoStub();
  try {
    const data = await printNodeFetch<PrintNodeWhoamiResponse>(
      apiKey,
      "/whoami",
    );
    return { ok: true, email: data.email };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List available printers from PrintNode.
 */
export async function listarImpressoras(
  apiKey: string,
): Promise<PrintNodePrinter[]> {
  if (isPrintNodeDisabled()) return listarImpressorasStub();
  const raw = await printNodeFetch<PrintNodePrinterRaw[]>(
    apiKey,
    "/printers",
  );
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    computer: p.computer.name,
    state: p.state,
  }));
}

/**
 * Send a PDF print job to PrintNode.
 * - 10s timeout
 * - 1 retry on network error
 */
export async function enviarImpressao(params: {
  apiKey: string;
  printerId: number;
  pdfUrl: string;
  titulo: string;
}): Promise<{ jobId: number }> {
  if (isPrintNodeDisabled()) {
    // pdfUrl é um URL string (não bytes) — codifica como base64 só pra
    // alimentar o buffer do stub. Bridge stub's string id → numeric jobId
    // pra manter o contrato { jobId: number }.
    const { id } = await enviarImpressaoStub({
      printerId: params.printerId,
      titulo: params.titulo,
      contentBase64: Buffer.from(params.pdfUrl).toString("base64"),
    });
    const jobId = Number(id.replace(/\D/g, "")) || 0;
    return { jobId };
  }
  const { apiKey, printerId, pdfUrl, titulo } = params;

  const body = JSON.stringify({
    printerId,
    contentType: "pdf_uri",
    content: pdfUrl,
    title: titulo,
    source: "SISO Separacao",
  });

  const doRequest = async (): Promise<number> => {
    const res = await fetch(`${PRINTNODE_BASE}/printjobs`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(apiKey),
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PrintNode ${res.status}: ${text}`);
    }

    return res.json() as Promise<number>;
  };

  let jobId: number;
  try {
    jobId = await doRequest();
  } catch (err) {
    // Retry once on network error
    const isNetworkError =
      err instanceof TypeError ||
      (err instanceof Error && err.name === "AbortError");
    if (!isNetworkError) throw err;

    logger.warn("printnode", "Retrying print job after network error", {
      printerId: String(printerId),
    });
    jobId = await doRequest();
  }

  logger.info("printnode", "Print job sent", {
    printerId: String(printerId),
    jobId: String(jobId),
  });

  return { jobId };
}

/**
 * Send a raw ZPL print job to PrintNode.
 * ZPL content is sent as base64-encoded raw data — PrintNode forwards it
 * directly to the thermal printer without any rendering.
 * - 10s timeout
 * - 1 retry on network error
 */
export async function enviarImpressaoZpl(params: {
  apiKey: string;
  printerId: number;
  zpl: string;
  titulo: string;
}): Promise<{ jobId: number }> {
  if (isPrintNodeDisabled()) {
    const { id } = await enviarImpressaoZplStub({
      printerId: params.printerId,
      titulo: params.titulo,
      zpl: params.zpl,
    });
    const jobId = Number(id.replace(/\D/g, "")) || 0;
    return { jobId };
  }
  const { apiKey, printerId, zpl, titulo } = params;

  const zplBase64 = Buffer.from(zpl).toString("base64");

  const body = JSON.stringify({
    printerId,
    contentType: "raw_base64",
    content: zplBase64,
    title: titulo,
    source: "SISO Separacao",
    expireAfter: 300,
  });

  const doRequest = async (): Promise<number> => {
    const res = await fetch(`${PRINTNODE_BASE}/printjobs`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(apiKey),
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PrintNode ${res.status}: ${text}`);
    }

    return res.json() as Promise<number>;
  };

  let jobId: number;
  try {
    jobId = await doRequest();
  } catch (err) {
    const isNetworkError =
      err instanceof TypeError ||
      (err instanceof Error && err.name === "AbortError");
    if (!isNetworkError) throw err;

    logger.warn("printnode", "Retrying ZPL print job after network error", {
      printerId: String(printerId),
    });
    jobId = await doRequest();
  }

  logger.info("printnode", "ZPL print job sent", {
    printerId: String(printerId),
    jobId: String(jobId),
  });

  return { jobId };
}

// ─── Printer resolution cache ─────────────────────────────────────────────
//
// Resolvers retornam `apiKey` da conta dona da impressora (multi-key). Sem a
// key correta o print job dá 401 — então o resolver é a única fonte da
// verdade pra "qual key usar nessa impressora".

interface ResolvedPrinter {
  printerId: number;
  printerNome: string;
  apiKey: string;
}

const printerCache = new Map<string, { value: ResolvedPrinter | null; expiresAt: number }>();
const PRINTER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve which printer to use for a given user + galpao.
 * Priority: usuario.printnode_printer_id > galpao.printnode_printer_id > null
 *
 * Carrega também a `api_key` da conta PrintNode (siso_printnode_contas)
 * dona daquela impressora. Se a conta estiver inativa ou tiver sido
 * deletada (account_id virou null), retorna null.
 *
 * Results are cached in-memory for 5 minutes to avoid repeated DB lookups
 * during high-throughput packing sessions.
 */
export async function resolverImpressora(
  usuarioId: string,
  galpaoId: string,
): Promise<ResolvedPrinter | null> {
  const cacheKey = `${usuarioId}|${galpaoId}`;
  const cached = printerCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const supabase = createServiceClient();

  const [userResult, galpaoResult] = await Promise.all([
    supabase
      .from("siso_usuarios")
      .select(
        "printnode_printer_id, printnode_printer_nome, printnode_account_id, " +
          "conta:siso_printnode_contas!siso_usuarios_printnode_account_id_fkey(api_key, ativo)",
      )
      .eq("id", usuarioId)
      .single(),
    supabase
      .from("siso_galpoes")
      .select(
        "printnode_printer_id, printnode_printer_nome, printnode_account_id, " +
          "conta:siso_printnode_contas!siso_galpoes_printnode_account_id_fkey(api_key, ativo)",
      )
      .eq("id", galpaoId)
      .single(),
  ]);

  type Row = {
    printnode_printer_id: number | null;
    printnode_printer_nome: string | null;
    printnode_account_id: string | null;
    conta: { api_key: string; ativo: boolean } | null;
  };

  const u = userResult.data as Row | null;
  const g = galpaoResult.data as Row | null;

  const pick = (row: Row | null): ResolvedPrinter | null => {
    if (!row?.printnode_printer_id || !row.conta?.ativo || !row.conta?.api_key) return null;
    return {
      printerId: row.printnode_printer_id,
      printerNome: row.printnode_printer_nome ?? "",
      apiKey: row.conta.api_key,
    };
  };

  const result = pick(u) ?? pick(g);

  printerCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRINTER_CACHE_TTL_MS });
  return result;
}

/** Clear the printer cache (e.g. after config changes). */
export function invalidarCacheImpressora(): void {
  printerCache.clear();
}

interface ResolvedPrinterProduto extends ResolvedPrinter {
  fallbackEnvelope: boolean;
}

/** Tipos de etiqueta com impressora dedicada (fora a de envio). */
type TipoEtiqueta = "produto" | "excesso";

const printerTipoCache = new Map<string, { value: ResolvedPrinterProduto | null; expiresAt: number }>();

/**
 * Resolve a impressora de uma etiqueta com sufixo dedicado (`_produto` pra
 * recebimento/guarda, `_excesso` pra a 10×15 de overstock). Diferente de
 * `resolverImpressora` (etiqueta de envio): prioriza os campos do sufixo. Se
 * nenhum estiver configurado, faz fallback pra impressora padrão (mesma da
 * etiqueta de envio) — assim funciona out-of-the-box até o admin configurar
 * uma impressora dedicada.
 *
 * Prioridade (sufixo = _produto | _excesso):
 *   1. usuario.printnode_printer_id{sufixo}
 *   2. galpao.printnode_printer_id{sufixo}
 *   3. usuario.printnode_printer_id           (fallback envelope)
 *   4. galpao.printnode_printer_id            (fallback envelope)
 *
 * Cada candidato carrega sua própria api_key (da conta do sufixo pro
 * dedicado, conta padrão pro fallback envelope). Se a conta estiver
 * inativa/sumida, cai pro próximo nível.
 */
async function resolverImpressoraPorTipo(
  tipo: TipoEtiqueta,
  usuarioId: string,
  galpaoId: string,
): Promise<ResolvedPrinterProduto | null> {
  const cacheKey = `${tipo}|${usuarioId}|${galpaoId}`;
  const cached = printerTipoCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const supabase = createServiceClient();
  const colId = `printnode_printer_id_${tipo}`;
  const colNome = `printnode_printer_nome_${tipo}`;
  const colConta = `printnode_account_id_${tipo}`;
  const selectDe = (tabela: "siso_usuarios" | "siso_galpoes") =>
    "printnode_printer_id, printnode_printer_nome, printnode_account_id, " +
    `${colId}, ${colNome}, ${colConta}, ` +
    `conta_envio:siso_printnode_contas!${tabela}_printnode_account_id_fkey(api_key, ativo), ` +
    `conta_tipo:siso_printnode_contas!${tabela}_${colConta}_fkey(api_key, ativo)`;

  const [userResult, galpaoResult] = await Promise.all([
    supabase
      .from("siso_usuarios")
      .select(selectDe("siso_usuarios"))
      .eq("id", usuarioId)
      .single(),
    supabase
      .from("siso_galpoes")
      .select(selectDe("siso_galpoes"))
      .eq("id", galpaoId)
      .single(),
  ]);

  type Row = {
    printnode_printer_id: number | null;
    printnode_printer_nome: string | null;
    conta_envio: { api_key: string; ativo: boolean } | null;
    conta_tipo: { api_key: string; ativo: boolean } | null;
  } & Record<string, unknown>;

  const u = userResult.data as Row | null;
  const g = galpaoResult.data as Row | null;

  type Candidate = { resolved: ResolvedPrinter; fallback: boolean } | null;
  const pickTipo = (row: Row | null): Candidate => {
    const printerId = row?.[colId] as number | null | undefined;
    if (!printerId || !row?.conta_tipo?.ativo || !row.conta_tipo?.api_key) return null;
    return {
      resolved: {
        printerId,
        printerNome: (row[colNome] as string | null) ?? "",
        apiKey: row.conta_tipo.api_key,
      },
      fallback: false,
    };
  };
  const pickEnvio = (row: Row | null): Candidate => {
    if (!row?.printnode_printer_id || !row.conta_envio?.ativo || !row.conta_envio?.api_key) return null;
    return {
      resolved: {
        printerId: row.printnode_printer_id,
        printerNome: row.printnode_printer_nome ?? "",
        apiKey: row.conta_envio.api_key,
      },
      fallback: true,
    };
  };

  const candidate = pickTipo(u) ?? pickTipo(g) ?? pickEnvio(u) ?? pickEnvio(g);

  const result: ResolvedPrinterProduto | null = candidate
    ? { ...candidate.resolved, fallbackEnvelope: candidate.fallback }
    : null;

  printerTipoCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + PRINTER_CACHE_TTL_MS,
  });
  return result;
}

/** Impressora da etiqueta de PRODUTO (recebimento/guarda). */
export function resolverImpressoraProduto(
  usuarioId: string,
  galpaoId: string,
): Promise<ResolvedPrinterProduto | null> {
  return resolverImpressoraPorTipo("produto", usuarioId, galpaoId);
}

/** Impressora da etiqueta de EXCESSO (10×15 paisagem, overstock). */
export function resolverImpressoraExcesso(
  usuarioId: string,
  galpaoId: string,
): Promise<ResolvedPrinterProduto | null> {
  return resolverImpressoraPorTipo("excesso", usuarioId, galpaoId);
}

/** Clear the produto/excesso printer cache (after config changes). */
export function invalidarCacheImpressoraProduto(): void {
  printerTipoCache.clear();
}
