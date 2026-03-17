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

const printerCache = new Map<string, { value: { printerId: number; printerNome: string } | null; expiresAt: number }>();
const PRINTER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve which printer to use for a given user + galpao.
 * Priority: usuario.printnode_printer_id > galpao.printnode_printer_id > null
 *
 * Results are cached in-memory for 5 minutes to avoid repeated DB lookups
 * during high-throughput packing sessions.
 */
export async function resolverImpressora(
  usuarioId: string,
  galpaoId: string,
): Promise<{ printerId: number; printerNome: string } | null> {
  const cacheKey = `${usuarioId}|${galpaoId}`;
  const cached = printerCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const supabase = createServiceClient();

  // Fetch user + galpao in parallel (single round-trip)
  const [userResult, galpaoResult] = await Promise.all([
    supabase
      .from("siso_usuarios")
      .select("printnode_printer_id, printnode_printer_nome")
      .eq("id", usuarioId)
      .single(),
    supabase
      .from("siso_galpoes")
      .select("printnode_printer_id, printnode_printer_nome")
      .eq("id", galpaoId)
      .single(),
  ]);

  let result: { printerId: number; printerNome: string } | null = null;

  if (userResult.data?.printnode_printer_id) {
    result = {
      printerId: userResult.data.printnode_printer_id,
      printerNome: userResult.data.printnode_printer_nome ?? "",
    };
  } else if (galpaoResult.data?.printnode_printer_id) {
    result = {
      printerId: galpaoResult.data.printnode_printer_id,
      printerNome: galpaoResult.data.printnode_printer_nome ?? "",
    };
  }

  printerCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRINTER_CACHE_TTL_MS });
  return result;
}

/** Clear the printer cache (e.g. after config changes). */
export function invalidarCacheImpressora(): void {
  printerCache.clear();
}
