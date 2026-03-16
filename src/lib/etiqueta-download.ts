/**
 * Download and extract ZPL content from Tiny etiqueta URLs.
 *
 * Tiny returns a ZIP file containing:
 *   - "Etiqueta de envio.txt" — the raw ZPL label
 *   - "Controle.pdf" — a control PDF (ignored)
 *
 * This module handles downloading, unzipping, and extracting the ZPL text.
 */

import JSZip from "jszip";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "etiqueta-download";

/**
 * Download a Tiny etiqueta URL and extract the ZPL content.
 * Returns the raw ZPL text, or null on failure.
 */
export async function baixarZpl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.warn(LOG_SOURCE, "Falha ao baixar etiqueta", {
        url,
        status: String(res.status),
      });
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const buffer = await res.arrayBuffer();

    // If it's a ZIP, extract the ZPL file from inside
    if (contentType.includes("zip") || contentType.includes("octet-stream")) {
      return await extrairZplDoZip(Buffer.from(buffer), url);
    }

    // Otherwise treat as raw text (legacy/fallback)
    const text = new TextDecoder().decode(buffer);
    if (validarZpl(text)) return text;

    logger.warn(LOG_SOURCE, "Conteúdo não é ZPL válido", {
      url,
      contentType,
      contentLength: String(buffer.byteLength),
      preview: text.substring(0, 100),
    });
    return null;
  } catch (err) {
    logger.warn(LOG_SOURCE, "Erro ao baixar etiqueta", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function extrairZplDoZip(
  buffer: Buffer,
  url: string,
): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(buffer);

    // Look for the ZPL file (usually "Etiqueta de envio.txt")
    const zplEntry =
      zip.file("Etiqueta de envio.txt") ??
      Object.values(zip.files).find(
        (f) => !f.dir && (f.name.endsWith(".txt") || f.name.endsWith(".zpl")),
      );

    if (!zplEntry) {
      logger.warn(LOG_SOURCE, "ZIP não contém arquivo ZPL", {
        url,
        files: Object.keys(zip.files).join(", "),
      });
      return null;
    }

    const text = await zplEntry.async("text");
    if (validarZpl(text)) return text;

    logger.warn(LOG_SOURCE, "Arquivo extraído do ZIP não é ZPL válido", {
      url,
      fileName: zplEntry.name,
      preview: text.substring(0, 100),
    });
    return null;
  } catch (err) {
    logger.warn(LOG_SOURCE, "Falha ao descompactar ZIP", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function validarZpl(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();
  // ZPL commands start with ^ or ~ (e.g. ^XA, ~DG for graphic labels like Shopee)
  return trimmed.startsWith("^") || trimmed.startsWith("~");
}

/**
 * Split a ZPL string containing multiple concatenated labels into individual labels.
 * Each label is delimited by ^XA ... ^XZ. Any preceding content (e.g. ~DG graphic
 * definitions for Shopee labels) is included with the following ^XA block.
 *
 * Returns at least one element (the original string if no split boundaries found).
 */
export function splitZplLabels(zpl: string): string[] {
  if (!zpl) return [];

  const labels: string[] = [];
  let remaining = zpl;

  while (remaining.length > 0) {
    const xzIdx = remaining.indexOf("^XZ");
    if (xzIdx === -1) break;

    const label = remaining.substring(0, xzIdx + 3).trim();
    remaining = remaining.substring(xzIdx + 3);

    if (label.includes("^XA")) {
      labels.push(label);
    }
  }

  return labels.length > 0 ? labels : [zpl];
}
