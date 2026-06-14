/**
 * Decodificação de barcodes/QR de etiquetas ZPL RASTER (~DG bitmap).
 *
 * Caso Shopee: a etiqueta inteira é UMA imagem (~DG + ^XG). Nenhum código está
 * como texto no ZPL — nem o rastreio (BR...), nem a DANFE, nem os QR de triagem.
 * O Tiny também não expõe o rastreio em dado (expedicao.codigoRastreio vem
 * vazio). A única fonte dos valores é a própria imagem: aqui expandimos o
 * bitmap 1bpp do ~DG e lemos os barcodes impressos com zxing-wasm.
 *
 * Para ZPL de COMANDOS (Mercado Livre: ^BC/^BQ) isto NÃO se aplica — use
 * extrairBarcodesDoZpl (etiqueta-barcode.ts). Retorna [] se não houver ~DG,
 * se o decode da imagem falhar ou se nenhum código for lido.
 */
import { inflateSync } from "node:zlib";
import { readBarcodesFromImageData } from "zxing-wasm/reader";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "etiqueta-raster";

export async function extrairBarcodesDoRaster(
  zpl: string | null | undefined,
): Promise<string[]> {
  if (!zpl || !zpl.includes("~DG")) return [];
  try {
    const img = renderizarDG(zpl);
    if (!img) return [];
    const results = await readBarcodesFromImageData(
      { data: img.data, width: img.width, height: img.height } as ImageData,
      { tryHarder: true },
    );
    const valores = new Set<string>();
    for (const r of results) {
      const v = (r.text ?? "").trim();
      if (v.length >= 4) valores.add(v);
    }
    return Array.from(valores);
  } catch (err) {
    logger.warn(LOG_SOURCE, "Falha ao decodificar barcodes do raster", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

interface RasterImg {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Parse do 1º comando ~DG e expansão do bitmap 1bpp (MSB-first) em RGBA. */
function renderizarDG(zpl: string): RasterImg | null {
  // ~DGd:o.x,totalBytes,bytesPerRow,data
  const m = /~DG[^,]*,(\d+),(\d+),/.exec(zpl);
  if (!m) return null;
  const totalBytes = parseInt(m[1], 10);
  const bytesPerRow = parseInt(m[2], 10);
  if (!bytesPerRow || !totalBytes) return null;

  // dados seguem até o próximo comando ZPL (^ ou ~)
  const dados = zpl.slice(m.index + m[0].length).split(/[\^~]/)[0];
  const raw = decodificarDadosGraficos(dados, totalBytes);
  if (!raw) return null;

  const width = bytesPerRow * 8;
  const height = Math.floor(raw.length / bytesPerRow);
  if (width <= 0 || height <= 0) return null;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let bx = 0; bx < bytesPerRow; bx++) {
      const byte = raw[y * bytesPerRow + bx];
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        const preto = (byte >> (7 - bit)) & 1; // bit=1 → tinta
        const v = preto ? 0 : 255;
        const i = (y * width + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
  }
  return { data, width, height };
}

/** :Z64: (zlib+base64), :B64: (base64) ou hex ASCII. */
function decodificarDadosGraficos(dados: string, totalBytes: number): Buffer | null {
  const z64 = /:Z64:([A-Za-z0-9+/=]+)/.exec(dados);
  if (z64) return inflateSync(Buffer.from(z64[1], "base64"));
  const b64 = /:B64:([A-Za-z0-9+/=]+)/.exec(dados);
  if (b64) return Buffer.from(b64[1], "base64");
  const hex = dados.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length >= totalBytes * 2) {
    return Buffer.from(hex.slice(0, totalBytes * 2), "hex");
  }
  return null;
}
