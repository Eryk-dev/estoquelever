/**
 * PrintNode API client for server-side label printing.
 *
 * - testarConexao: validates API key via GET /whoami
 * - listarImpressoras: lists available printers via GET /printers
 * - enviarImpressao: sends a PDF print job via POST /printjobs (10s timeout, 1 retry)
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
 * Resolve which printer to use for a given user + galpao.
 * Priority: usuario.printnode_printer_id > galpao.printnode_printer_id > null
 */
export async function resolverImpressora(
  usuarioId: string,
  galpaoId: string,
): Promise<{ printerId: number; printerNome: string } | null> {
  const supabase = createServiceClient();

  // Check user override first
  const { data: usuario } = await supabase
    .from("siso_usuarios")
    .select("printnode_printer_id, printnode_printer_nome")
    .eq("id", usuarioId)
    .single();

  if (usuario?.printnode_printer_id) {
    return {
      printerId: usuario.printnode_printer_id,
      printerNome: usuario.printnode_printer_nome ?? "",
    };
  }

  // Fallback to galpao default
  const { data: galpao } = await supabase
    .from("siso_galpoes")
    .select("printnode_printer_id, printnode_printer_nome")
    .eq("id", galpaoId)
    .single();

  if (galpao?.printnode_printer_id) {
    return {
      printerId: galpao.printnode_printer_id,
      printerNome: galpao.printnode_printer_nome ?? "",
    };
  }

  return null;
}
