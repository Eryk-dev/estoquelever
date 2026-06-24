/**
 * Extração de barcodes do ZPL da etiqueta de envio (conferência de embalagem).
 *
 * O bip do leitor na bancada devolve o VALOR codificado no barcode — pra casar
 * o bip com o pedido, extraímos os valores de todos os barcodes do ZPL na hora
 * em que ele é persistido e gravamos em siso_pedidos.etiqueta_barcodes.
 *
 * Cobertura por marketplace:
 * - Mercado Livre: ZPL de comandos (^BC Code128, ^BQ QR) — extraível daqui.
 * - Shopee: gráfico raster (~DG/^XG), SEM comandos de barcode — nada é
 *   extraível daqui. Os códigos (rastreio BR... + DANFE) são lidos do bitmap
 *   por `extrairBarcodesDoRaster` (etiqueta-barcode-raster.ts) e passados como
 *   extras a montarBarcodesEtiqueta. O codigoRastreio do Tiny vem vazio.
 */

/** Comandos ZPL que iniciam um campo de barcode (o próximo ^FD é o dado). */
const BARCODE_CMDS = /^B[0-9A-Z]/;

/**
 * Comandos que podem aparecer entre o comando de barcode e o ^FD sem cancelar
 * o campo. ^BY (largura de módulo) é parâmetro, não campo — também passa.
 */
const PASSTHROUGH_CMDS = /^(FH|CI|FW|FO|FT|BY)/;

/**
 * Normaliza o dado do ^FD pro valor que o leitor devolve no scan:
 * - Code128/39: remove escapes de troca de subset (`>` + 1 char — ex `>;`, `>:`, `>5`)
 * - QR (^BQ): remove o prefixo de modo (`LA,`, `QA,`, `H,`, ...)
 */
function normalizarDado(cmd: string, dado: string): string {
  if (cmd.startsWith("BQ")) {
    return dado.replace(/^[HQLM][A-Z]?,/, "").trim();
  }
  return dado.replace(/>./g, "").trim();
}

/**
 * Varre o ZPL e retorna os valores únicos de todos os barcodes.
 * Retorna [] pra ZPL raster (Shopee), texto sem barcode ou input vazio.
 */
export function extrairBarcodesDoZpl(zpl: string | null | undefined): string[] {
  if (!zpl) return [];

  const valores = new Set<string>();
  // Tokens = conteúdo entre carets. ^FD termina no próximo ^ (tipicamente ^FS).
  const tokens = zpl.split("^");
  let barcodeCmd: string | null = null;

  for (const token of tokens) {
    if (!token) continue;

    if (barcodeCmd && token.startsWith("FD")) {
      const valor = normalizarDado(barcodeCmd, token.slice(2));
      if (valor.length >= 4) valores.add(valor);
      // QR ML: o shipment id viaja dentro do JSON (`{"id":"…",…}`). No Flex NÃO
      // há Code128 com o id cru — só o QR — então guarda o `id` standalone,
      // senão o bip do QR não casa por overlap (igualdade de elemento do array).
      const idMl = /"id"\s*:\s*"?(\d{8,})"?/.exec(valor);
      if (idMl) valores.add(idMl[1]);
      barcodeCmd = null;
      continue;
    }

    if (BARCODE_CMDS.test(token) && !token.startsWith("BY")) {
      barcodeCmd = token;
      continue;
    }

    // Qualquer outro comando (exceto passthrough) entre o barcode e o ^FD
    // significa que o campo de barcode não tem dado — cancela.
    if (barcodeCmd && !PASSTHROUGH_CMDS.test(token)) {
      barcodeCmd = null;
    }
  }

  return Array.from(valores);
}

/**
 * Une os barcodes extraídos do ZPL com valores extras conhecidos
 * (codigoRastreio da expedição Tiny — única fonte pra Shopee raster).
 * Dedup, sem vazios.
 */
export function montarBarcodesEtiqueta(
  zpl: string | null | undefined,
  extras: Array<string | null | undefined> = [],
): string[] {
  const valores = new Set<string>(extrairBarcodesDoZpl(zpl));
  for (const extra of extras) {
    const v = extra?.trim();
    if (v && v.length >= 4) valores.add(v);
  }
  return Array.from(valores);
}
