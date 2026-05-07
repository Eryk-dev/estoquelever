/**
 * Extrai códigos OEM da descrição complementar do Tiny.
 * Portado de cross/backend/src/services/tiny/product-operations.ts:15-78
 *
 * Procura padrões como:
 *   - "OEM: ABC-123 DEF456 GH-001"
 *   - Linhas com códigos no formato uppercase + dígitos + traço (4-15 chars)
 *
 * Retorna lista única em uppercase, sem duplicatas.
 */
export function extrairOEMs(descricao: string | null | undefined): string[] {
  if (!descricao) return [];

  const oemCodes: string[] = [];
  const cleanedDesc = descricao
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Estratégia 1: linha "OEM: códigos"
  const oemMatch = cleanedDesc.match(/OEM[:\s]+([A-Z0-9][A-Z0-9\s\-.]+)/i);
  if (oemMatch && oemMatch[1]) {
    const codes = oemMatch[1].trim().split(/\s+/).filter((c) => c.length > 0);
    for (const code of codes) {
      const normalized = normalizeOemCode(code);
      if (isValidOemCode(normalized)) {
        oemCodes.push(normalized);
      }
    }
  }

  // Estratégia 2 (fallback): se não achou nada com estratégia 1, varre tokens
  if (!oemMatch) {
    const tokens = cleanedDesc.split(/[\s,;]+/);
    for (const token of tokens) {
      const normalized = normalizeOemCode(token);
      if (isValidOemCode(normalized) && looksLikeOemCode(normalized)) {
        oemCodes.push(normalized);
      }
    }
  }

  return [...new Set(oemCodes)];
}

function normalizeOemCode(code: string): string {
  return code.replace(/[^A-Z0-9.\-]/gi, "").toUpperCase();
}

function isValidOemCode(code: string): boolean {
  return code.length >= 4 && code.length <= 30;
}

/**
 * Heurística: parece um código OEM "real" (uppercase + dígitos + traço, 4-15 chars).
 * Filtra ruído tipo palavras comuns ou números soltos.
 */
function looksLikeOemCode(code: string): boolean {
  if (code.length < 4 || code.length > 15) return false;
  const hasLetter = /[A-Z]/.test(code);
  const hasDigit = /[0-9]/.test(code);
  return hasLetter && hasDigit;
}

/**
 * Verificação manual rápida (rodar com: npx tsx src/lib/cross/oem-extractor.ts):
 *
 *   - extrairOEMs("OEM: 94530230 ABC-001")           // ['94530230', 'ABC-001']
 *   - extrairOEMs("Filtro genérico sem OEM")         // []
 *   - extrairOEMs("OEM: 94530230\nMore lines")       // ['94530230']
 *   - extrairOEMs("OEM: ABC123 ABC123 DEF456")       // ['ABC123', 'DEF456']
 *   - extrairOEMs("Sample: AB12 EFG-789 invalido")   // ['AB12', 'EFG-789'] (estratégia 2)
 *   - extrairOEMs("")                                // []
 *   - extrairOEMs(null)                              // []
 *   - extrairOEMs("OEM<br>94530230")                 // ['94530230']
 *   - extrairOEMs("OEM:<br>ABC-123 DEF456")          // ['ABC-123', 'DEF456']
 */
