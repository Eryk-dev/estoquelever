/**
 * Maps CNPJ → branch (filial).
 * Used to identify which branch sent the webhook.
 */

const CNPJ_MAP: Record<string, "CWB" | "SP"> = {
  "34857388000163": "CWB",
  "34857388000244": "SP",
};

/** Trade name per branch (used in stock movement descriptions) */
const FILIAL_NOME: Record<"CWB" | "SP", string> = {
  CWB: "NetAir",
  SP: "NetParts",
};

export function getFilialByCnpj(cnpj: string): "CWB" | "SP" | null {
  // Strip formatting
  const clean = cnpj.replace(/\D/g, "");
  return CNPJ_MAP[clean] ?? null;
}

export function getNomeFilial(filial: "CWB" | "SP"): string {
  return FILIAL_NOME[filial];
}
